#!/usr/bin/env node
/* 凭据本地加密测试。
   浏览器代码没法在这个环境真跑（jsdom 装不上），
   但**算法本身**能用 Node 的 WebCrypto 真跑 ——
   尤其是"密钥不可导出"这条，能真正验证，不是查字符串。 */
const fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(R, 'js/oj.js'), 'utf8');
const doc = fs.readFileSync(path.join(R, 'docs/做题平台.md'), 'utf8');
const wc = require('crypto').webcrypto;

let P = 0, F = 0;
const t = (n, ok, e) => { ok ? (P++, console.log('  ✅ ' + n)) : (F++, console.log('  ❌ ' + n + (e ? ' —— ' + e : ''))); };

console.log('凭据加密存储测试');

/* ---------- A. 真跑 WebCrypto：验证算法性质 ---------- */
(async () => {
  const k = await wc.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const enc = new TextEncoder(), dec = new TextDecoder();

  /* 这条是核心：密钥不可导出。
     能导出的话，密钥就只是"藏起来了"，而不是"拿不走"。 */
  let exported = null;
  try { await wc.subtle.exportKey('raw', k); exported = '导出成功'; } catch (e) { exported = null; }
  t('密钥不可导出（exportKey 会失败）', exported === null, exported || '');

  const plain = 'handle=liu; JSESSIONID=abc123; ftaa=xyz';
  const iv1 = wc.getRandomValues(new Uint8Array(12));
  const ct1 = await wc.subtle.encrypt({ name: 'AES-GCM', iv: iv1 }, k, enc.encode(plain));
  const back = dec.decode(await wc.subtle.decrypt({ name: 'AES-GCM', iv: iv1 }, k, ct1));
  t('加解密往返正确', back === plain);

  /* IV 必须随机：同一明文两次加密结果不同 */
  const iv2 = wc.getRandomValues(new Uint8Array(12));
  const ct2 = await wc.subtle.encrypt({ name: 'AES-GCM', iv: iv2 }, k, enc.encode(plain));
  t('同一明文两次密文不同（IV 随机）',
    Buffer.from(ct1).toString('base64') !== Buffer.from(ct2).toString('base64'));
  t('两次 IV 不同', Buffer.from(iv1).toString('base64') !== Buffer.from(iv2).toString('base64'));

  /* GCM 有认证：篡改密文必须解不开，而不是解出乱码 */
  const bad = new Uint8Array(ct1); bad[3] ^= 0xff;
  let tamper = null;
  try { await wc.subtle.decrypt({ name: 'AES-GCM', iv: iv1 }, k, bad); } catch (e) { tamper = 'rejected'; }
  t('篡改密文解不开（GCM 有认证）', tamper === 'rejected');

  /* 换密钥解不开 */
  const k2 = await wc.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  let wrongKey = null;
  try { await wc.subtle.decrypt({ name: 'AES-GCM', iv: iv1 }, k2, ct1); } catch (e) { wrongKey = 'rejected'; }
  t('换密钥解不开', wrongKey === 'rejected');

  /* 空串也要能往返（清空凭据时会走到） */
  const ivE = wc.getRandomValues(new Uint8Array(12));
  const ctE = await wc.subtle.encrypt({ name: 'AES-GCM', iv: ivE }, k, enc.encode(''));
  t('空串可往返', dec.decode(await wc.subtle.decrypt({ name: 'AES-GCM', iv: ivE }, k, ctE)) === '');

  /* ---------- B. 源码接线（剥注释） ---------- */
  /* ⚠ 必须先剥注释：注释里为了说明规则会提到反例
     （比如"绝不硬编码密钥"这句话本身就带"密钥"两个字）。
     这是本项目第 7 次栽在这个坑上。 */
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const code = strip(src);
  t('剥完注释还剩内容', code.length > 3000 && code.length < src.length);

  t('用 generateKey 生成密钥', /generateKey\(\{[^}]*AES-GCM/.test(code));
  t('第二个参数是 false（不可导出）', /generateKey\([^)]*,\s*false\s*,/.test(code));
  t('没有硬编码的密钥字面量', !/(?:key|密钥)\s*=\s*["'][A-Za-z0-9+\/]{16,}["']/i.test(code));
  t('IV 每次随机（不是固定值）', /getRandomValues/.test(code));
  t('IV 长度 12（GCM 标准）', /new Uint8Array\(12\)/.test(code));
  t('密文带版本前缀 enc1', /enc1:/.test(code));

  /* 降级：没有 WebCrypto 时绝不能落盘明文 */
  /* 精确取 `if (!WC) { ... }` 这一个块再判断。
     用宽松范围的话会跨到后面正常的 setItem 分支上，
     于是**真实代码里真写了明文落盘也会被判成没有**。 */
  const wcB = /if \(!WC\)\s*\{[\s\S]*?\n    \}/.exec(code);
  t('取到 !WC 分支块', !!wcB);
  t('无 WebCrypto 时直接拒绝（不落盘明文）',
    !!wcB && /Promise\.reject/.test(wcB[0]) && !/setItem/.test(wcB[0]),
    wcB ? wcB[0].slice(0, 90) : '');
  t('NO_WEBCRYPTO 时在界面上说清没保存', /没有\*\*保存|没有保存/.test(code));

  /* 三条读取分支必须分开 */
  t('旧明文会自动升级成密文', /migrate\(/.test(code) && /indexOf\('enc1:'\) !== 0/.test(code));
  t('解不开时提示重新填（不当成没填过）', /CRED_UNREADABLE/.test(code));
  t('解不开时给出可读的提示文案', /读不出来了/.test(code));

  /* 保存失败不阻断提交 */
  t('保存失败仍会提交（不阻断）', /saveCred\([\s\S]{0,200}?\.then\(post,\s*function/.test(code));

  /* 局限必须如实写进文档，不能吹 */
  t('文档说明本地加密挡不住 XSS（如实）', /XSS/.test(doc));
  t('文档说明密钥丢了要重填', /重新填|密钥丢/.test(doc));
  t('文档说明加密存储', /加密/.test(doc));

  console.log('\n通过 ' + P + ' / ' + (P + F));
  process.exit(F ? 1 : 0);
})();
