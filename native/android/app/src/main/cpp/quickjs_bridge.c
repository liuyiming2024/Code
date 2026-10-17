/* ============================================================
   QuickJS ← → JNI 桥接
   ------------------------------------------------------------
   职责：装解释器脚本、跑用户代码、捕获输出、按超时中断。

   ---------- 为什么必须用中断回调做超时 ----------
   QuickJS 里 `while(1){}` 是同步执行的，没有"取消"这回事。
   如果在 Java 侧用线程超时把线程停掉：
     - 引擎内部的循环**不会停**（没人通知它）
     - 线程被 kill 时 native 栈上的内存全部泄漏
     - 更糟：每跑一次死循环泄漏一个 Runtime
   正确做法：JS_SetInterruptHandler 注册回调，引擎每执行若干条指令
   就问一次"该停了吗"，到点返回 1，引擎自己抛异常并正常退出。
   —— 这**正是原生端相对网页端的优势**：网页端只能 terminate Worker。

   ---------- 为什么不用 C 注册输出回调 ----------
   改成在 JS 侧建一个数组收集：
       var __out = [];
       var I = Code.cpplite.create(function (s) { __out.push(s); }, ...);
   这样输出拼接完全在 JS 里完成，C 侧只读结果。
   避免跨 JNI 边界回调（每次输出都要 AttachCurrentThread，慢且易错）。

   ---------- 为什么必须先建 Code 全局对象 ----------
   cpplite.js / pylite.js 结尾是 `})(window)` 或 `Code.cpplite = {...}`，
   它们依赖名为 Code 的宿主对象存在。QuickJS 里没有 window，
   所以先 `globalThis.Code = {}`。忘了这步会得到
   "Code is not defined"，看起来像脚本损坏，实际是宿主没准备好。
   ============================================================ */

#include <jni.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "quickjs/quickjs.h"

#define LOG_TAG "code_runner"

typedef struct {
    JSRuntime *rt;
    JSContext *ctx;
    int64_t    deadline_ms;   /* 0 = 不限时 */
    int        timed_out;     /* 中断回调置 1 */
} Runner;

static int64_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* 中断回调：引擎周期性调用。返回 1 → 引擎抛出 "interrupted"。 */
static int on_interrupt(JSRuntime *rt, void *opaque) {
    (void)rt;
    Runner *r = (Runner *)opaque;
    if (!r || r->deadline_ms == 0) return 0;
    if (now_ms() > r->deadline_ms) {
        r->timed_out = 1;
        return 1;
    }
    return 0;
}

/* 取异常文本。不是异常则返回 NULL（调用方按"成功"处理）。 */
static char *take_error(JSContext *ctx, JSValue val) {
    if (!JS_IsException(val)) return NULL;
    JSValue e = JS_GetException(ctx);
    const char *s = JS_ToCString(ctx, e);
    char *out = s ? strdup(s) : strdup("（未知错误）");
    if (s) JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, e);
    return out;
}

/* 执行一段 JS，异常文本放入 *err（可为 NULL）。 */
static void eval_or_die(JSContext *ctx, const char *src, const char *name, char **err) {
    JSValue v = JS_Eval(ctx, src, strlen(src), name, JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(v)) {
        if (err && !*err) *err = take_error(ctx, v);
    }
    JS_FreeValue(ctx, v);
}

/* 读全局字符串变量（如 __out / __err / __to）。 */
static char *get_global_str(JSContext *ctx, const char *name) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, g, name);
    const char *s = JS_ToCString(ctx, v);
    char *out = s ? strdup(s) : strdup("");
    if (s) JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, g);
    return out;
}

extern JNIEXPORT jlong JNICALL
Java_io_code_app_run_QuickJsRunner_nativeNew(JNIEnv *env, jclass cls,
                                             jstring jscript, jstring jsource) {
    (void)cls;
    const char *script = (*env)->GetStringUTFChars(env, jscript, NULL);
    const char *source = jsource ? (*env)->GetStringUTFChars(env, jsource, NULL) : NULL;
    if (!script) return 0;

    Runner *r = (Runner *)calloc(1, sizeof(Runner));
    if (!r) {
        if (script) (*env)->ReleaseStringUTFChars(env, jscript, script);
        if (source) (*env)->ReleaseStringUTFChars(env, jsource, source);
        return 0;
    }

    r->rt  = JS_NewRuntime();
    r->ctx = JS_NewContext(r->rt);
    JS_SetInterruptHandler(r->rt, on_interrupt, r);

    /* 宿主对象必须先建好，见文件头说明。
       顺带把 window 也指过去：部分 UMD 包装会探测 window，
       缺了它宁可指向全局也别是 undefined。 */
    eval_or_die(r->ctx,
        "globalThis.Code = {};"
        "globalThis.window = globalThis;"
        "globalThis.__out = [];", "bootstrap", NULL);

    /* ---- 真正加载解释器源码 ----
       必须由 Java 侧从 assets 读进来传给我们：
       C 侧没有 Android asset 访问能力（AAssetManager 能用，
       但那样 C 就要依赖 android/asset_manager.h，耦合更重）。
       由 Java 读、C 只管 eval，职责更清楚。 */
    if (source) {
        eval_or_die(r->ctx, source, script, NULL);
    }

    if (script) (*env)->ReleaseStringUTFChars(env, jscript, script);
    if (source) (*env)->ReleaseStringUTFChars(env, jsource, source);
    return (jlong)(intptr_t)r;
}

extern JNIEXPORT void JNICALL
Java_io_code_app_run_QuickJsRunner_nativeFree(JNIEnv *env, jclass cls, jlong handle) {
    (void)env; (void)cls;
    if (!handle) return;
    Runner *r = (Runner *)(intptr_t)handle;
    if (r->ctx) JS_FreeContext(r->ctx);
    if (r->rt)  JS_FreeRuntime(r->rt);
    free(r);
}

extern JNIEXPORT jobjectArray JNICALL
Java_io_code_app_run_QuickJsRunner_nativeRun(
        JNIEnv *env, jclass cls, jlong handle,
        jstring jcode, jstring jstdin, jlong timeout_ms) {
    (void)cls;
    Runner *r = (Runner *)(intptr_t)handle;
    jclass strCls = (*env)->FindClass(env, "java/lang/String");
    jobjectArray res = (*env)->NewObjectArray(env, 3, strCls, NULL);

    if (!r) {
        jstring e = (*env)->NewStringUTF(env, "引擎句柄无效");
        (*env)->SetObjectArrayElement(env, res, 1, e);
        return res;
    }

    const char *code  = (*env)->GetStringUTFChars(env, jcode, NULL);
    const char *stdin_ = jstdin ? (*env)->GetStringUTFChars(env, jstdin, NULL) : NULL;

    r->timed_out = 0;
    r->deadline_ms = timeout_ms > 0 ? now_ms() + timeout_ms : 0;

    char *err = NULL;

    /* ---- 准备：stdin 与输出收集 ---- */
    /* ⚠ stdin 必须用 JSON.stringify 注入，不能直接拼进源码：
       输入里只要有引号/反斜杠/换行，拼出来的 JS 就是语法错误，
       报出来的是"程序有语法错误"，而用户的 C++ 代码完全没问题。 */
    JSValue g = JS_GetGlobalObject(r->ctx);
    JSValue jv = JS_NewString(r->ctx, stdin_ ? stdin_ : "");
    JS_SetPropertyStr(r->ctx, g, "__stdin", jv);
    JS_FreeValue(r->ctx, jv);
    JS_FreeValue(r->ctx, g);

    eval_or_die(r->ctx,
        "__out = [];"
        "__err = '';"
        "__to = 0;"
        "__inI = 0;"
        "__readInput = function () { return __stdin; };",
        "prepare", &err);

    if (!err) {
        /* 用户代码与调用包装分离：
           用户代码通过 __code 变量传入，避免引号转义问题（同上）。 */
        JSValue g2 = JS_GetGlobalObject(r->ctx);
        JSValue cv = JS_NewString(r->ctx, code ? code : "");
        JS_SetPropertyStr(r->ctx, g2, "__code", cv);
        JS_FreeValue(r->ctx, cv);
        JS_FreeValue(r->ctx, g2);

        eval_or_die(r->ctx,
            "try {"
            "  var I = Code.cpplite.create("
            "    function (s) { __out.push(String(s)); },"
            "    function () { return __readInput(); });"
            "  I.run(__code, { timeout: 0 });"   /* 超时交给中断回调，解释器内部不重复计时 */
            "} catch (e) {"
            "  __err = String((e && e.message) || e);"
            "  if (/interrupted/i.test(__err)) { __to = 1; __err = ''; }"
            "}"
            "__out = __out.join('');",
            "run", &err);
    }

    /* 中断回调置过位 → 判定为超时（优先于 err，因为 err 里是 "interrupted"） */
    if (r->timed_out) {
        char *out = get_global_str(r->ctx, "__out");
        (*env)->SetObjectArrayElement(env, res, 0, (*env)->NewStringUTF(env, out ? out : ""));
        (*env)->SetObjectArrayElement(env, res, 2, (*env)->NewStringUTF(env, "1"));
        free(out);
    } else {
        char *out = get_global_str(r->ctx, "__out");
        (*env)->SetObjectArrayElement(env, res, 0, (*env)->NewStringUTF(env, out ? out : ""));
        if (err) {
            (*env)->SetObjectArrayElement(env, res, 1, (*env)->NewStringUTF(env, err));
        }
        (*env)->SetObjectArrayElement(env, res, 2, (*env)->NewStringUTF(env, "0"));
        free(out);
    }

    if (err) free(err);
    if (code)   (*env)->ReleaseStringUTFChars(env, jcode, code);
    if (stdin_) (*env)->ReleaseStringUTFChars(env, jstdin, stdin_);
    return res;
}
