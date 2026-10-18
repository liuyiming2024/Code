/* vkeyboard.js 的键盘测试
 *
 * 修的是两个真问题：
 *
 * ① **按键几乎用不了 / 反应慢**
 *    原实现里 touchstart 只 preventDefault，真正干活的是 click。
 *    而 preventDefault 之后 click 是浏览器**合成**的 ——
 *    部分移动浏览器干脆不合成（按了没反应），
 *    即便合成也要等约 300ms（反应慢）。
 *
 * ② **桌面端键盘白占半屏**
 *    桌面有物理键盘，不该默认展开；但探测可能出错，
 *    所以折叠把手必须永远在 —— 那是唯一的自救出口。
 *
 * 这里全部是静态/逻辑断言，不需要真浏览器（jsdom 在本环境装不上）。 */
var fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');
var v = fs.readFileSync(path.join(root, 'js/vkeyboard.js'), 'utf8');
var css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');

var P = 0, F = 0;
function t(ok, name, extra) {
  if (ok) { P++; console.log('  ✅ ' + name); }
  else { F++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('vkeyboard 接线：');

/* ---- ① 按下即响应，不依赖合成的 click ---- */
t(v.indexOf("el.addEventListener('pointerdown', down)") >= 0,
  '按键走 pointerdown（按下即响应，不等合成的 click）');
/* 光有 pointerdown 不够：click 也会来一次 → 按一下插入两个字符 */
t(/addEventListener\('click', function \(e\)/.test(v) &&
  /hasPointer && Date\.now\(\) - lastDown < 700/.test(v),
  'click 要做去重（否则一次按键执行两遍，按一下插入两个字符）');
t(v.indexOf("e.preventDefault()") >= 0,
  '按下要 preventDefault（否则系统输入法弹出、光标丢失）');

/* ---- ② 桌面端默认折叠，但必须能展开 ---- */
t(v.indexOf('function isTouchDevice') >= 0, '要有触摸设备探测');
/* 判定只能有一份：两份写歪就会出现"提示算桌面、渲染算触摸" */
var n = (v.match(/pointer: coarse/g) || []).length;
t(n === 1, '触摸判定只能有一份（两份写歪会导致该出现时不出现且不报错）', '出现 ' + n + ' 次');
t(v.indexOf("return !isTouchDevice();") >= 0,
  '没选过时按设备猜：桌面端默认折叠');
t(v.indexOf("bar.classList.toggle('collapsed'") >= 0, '要有折叠态切换');
t(v.indexOf("t.textContent = v ? '▲ 展开键盘'") >= 0,
  '把手文案要随状态变（用户才知道点它是展开还是收起）');

/* 把手必须在折叠时也显示 —— 这是"探测错了"的唯一自救出口 */
t(/\.vkb\.collapsed \.vk-hint/.test(css) &&
  /\.vkb\.collapsed \.vk-body \{ display: none/.test(css),
  '折叠时隐藏键体');
t(!/\.vkb\.collapsed \.vk-toggle/.test(css),
  '折叠时**不能**隐藏把手（否则误判后无从恢复）');
t(/body\.has-vkb\.vkb-collapsed #workbench \{ padding-bottom: 42px/.test(css),
  '折叠时占位要跟着缩（否则底部空出一大片）');

/* 横屏那条媒体查询里也要覆盖，不然横屏折叠仍占 200px */
var mq = css.slice(css.indexOf('@media (max-height: 480px)'));
var mqEnd = css.indexOf('/* 扩展中心', mq);
mq = mqEnd > 0 ? mq.slice(0, mqEnd) : mq;
t(/vkb-collapsed #workbench \{ padding-bottom: 42px/.test(mq),
  '横屏媒体查询里同样要覆盖折叠占位');

/* ---- ③ data-act 命名空间冲突 ----
   键盘用 data-act 标记键位，命令绑定也用 [data-act] 全量匹配 ——
   撞名导致键盘上每个键都被当成命令，于是"按什么都没用，还弹命令未接入"。 */
var app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
var iBind = app.indexOf("U.$$('[data-act]')");
var iSkip = app.indexOf("closest('.vkb, .mobile-bar')");
/* ⚠ 不能直接全文查 closest 存在与否 —— 那样在别处出现也会通过（假阳性）。
   必须确认它就在绑定块**内部**：两者相邻且顺序正确。 */
t(iBind >= 0 && iSkip > iBind && iSkip - iBind < 1500,
  '命令全量绑定必须跳过键盘与移动键条（否则每个键都被当成命令）',
  'iBind=' + iBind + ' iSkip=' + iSkip);
/* 反向：不能因为跳过键盘，就把 data-act 全量绑定整段删掉 ——
   那样侧栏的新建/刷新按钮又会全部失效（E-041 修过的正是这个） */
t(app.indexOf("U.$$('[data-act]')") >= 0, 'data-act 全量绑定本身要保留（侧栏按钮靠它）');

/* 键盘自身的 act 不能指望命令分派来处理 */
t(v.indexOf("case 'shift'") >= 0 || v.indexOf("k.act === 'shift'") >= 0,
  '键盘的 shift 由自己处理，不依赖命令分派');

/* 探测函数要导出，便于外部核对与测试 */
t(v.indexOf('isTouchDevice: isTouchDevice') >= 0, 'isTouchDevice 要导出');

console.log('\n通过 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
