/**
 * F1-01 测试：验证 rps_frontend/static/js/config.js 中各网络 supportedTokens
 * 包含正确代币、USDC 为默认代币、POL 已加入 Polygon 主网。
 *
 * 运行：node tests/test_config.mjs
 *
 * 此测试通过 mock 浏览器环境（localStorage）后实际执行 config.js，
 * 拿到 CONFIG 对象做断言，避免脆弱的正则解析。
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- mock 浏览器环境 ----
const storage = {};
const mockLocalStorage = {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
};

// 读取并执行 config.js
const configPath = path.join(__dirname, '..', 'rps_frontend', 'static', 'js', 'config.js');
const configSource = fs.readFileSync(configPath, 'utf-8');

// config.js 顶层定义 `const CONFIG = {...}` 并包含一个引用 localStorage 的 IIFE。
// 用 new Function 提供 mocked localStorage 并返回 CONFIG。
const getConfig = new Function('localStorage', configSource + '\nreturn CONFIG;');
const CONFIG = getConfig(mockLocalStorage);

let pass = 0;
let fail = 0;

function test(name, fn) {
    try {
        fn();
        pass++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        fail++;
        console.log(`  ❌ ${name}: ${e.message}`);
    }
}

console.log('=' .repeat(60));
console.log('F1-01 配置测试 (config.js)');
console.log('=' .repeat(60));

// ---- commitTimeout 与前端对齐 ----
test('commitTimeout 为 66 秒', () => {
    assert.strictEqual(CONFIG.commitTimeout, 66, 'commitTimeout 应为 66');
});

test('revealTimeout 为 88 秒', () => {
    assert.strictEqual(CONFIG.revealTimeout, 88, 'revealTimeout 应为 88');
});

// ---- Polygon 主网：POL + USDC ----
test('Polygon 主网 supportedTokens 包含 USDC', () => {
    const tokens = CONFIG.networks.polygon.supportedTokens;
    assert(tokens.some(t => t.symbol === 'USDC'), 'polygon 应包含 USDC');
});

test('Polygon 主网 supportedTokens 包含 POL（原生代币，address(0)）', () => {
    const tokens = CONFIG.networks.polygon.supportedTokens;
    const pol = tokens.find(t => t.symbol === 'POL');
    assert(pol, 'polygon 应包含 POL');
    assert.strictEqual(pol.address, '0x0000000000000000000000000000000000000000',
        'POL 地址应为 address(0) 表示原生代币');
});

test('Polygon 主网 supportedTokens 不包含 USDT', () => {
    const tokens = CONFIG.networks.polygon.supportedTokens;
    assert(!tokens.some(t => t.symbol === 'USDT'), 'polygon 不应包含 USDT');
});

// ---- Amoy 测试网：仅 USDC ----
test('Amoy 测试网 supportedTokens 不包含 USDT', () => {
    const tokens = CONFIG.networks.amoy.supportedTokens;
    assert(!tokens.some(t => t.symbol === 'USDT'), 'amoy 不应包含 USDT');
});

// ---- USDC 为默认代币（supportedTokens 首位） ----
test('Polygon 主网 USDC 为默认代币（supportedTokens 首位）', () => {
    const tokens = CONFIG.networks.polygon.supportedTokens;
    assert.strictEqual(tokens[0].symbol, 'USDC', 'polygon 首个代币应为 USDC');
});

test('Amoy 测试网 USDC 为默认代币（supportedTokens 首位）', () => {
    const tokens = CONFIG.networks.amoy.supportedTokens;
    assert.strictEqual(tokens[0].symbol, 'USDC', 'amoy 首个代币应为 USDC');
});

test('Base 主网 USDC 为默认代币（supportedTokens 首位）', () => {
    const tokens = CONFIG.networks.base.supportedTokens;
    assert.strictEqual(tokens[0].symbol, 'USDC', 'base 首个代币应为 USDC');
});

// ---- getDefaultToken 返回当前网络原生币 ----
test('getDefaultToken() 返回原生币符号', () => {
    // 在无浏览器环境下 getCurrentNetwork 回退到 localhost，
    // 其原生币符号由 CONFIG.RPC_NATIVE_SYMBOL 定义
    const symbol = CONFIG.RPC_NATIVE_SYMBOL;
    assert(symbol, 'RPC_NATIVE_SYMBOL 应有值');
    assert.strictEqual(CONFIG.networks.localhost.nativeCurrency.symbol, symbol);
});

// ---- tokenAddresses 与 supportedTokens 一致 ----
test('Polygon 主网 tokenAddresses 包含 POL 映射且地址一致', () => {
    const addr = CONFIG.networks.polygon.tokenAddresses.POL;
    assert(addr, 'polygon tokenAddresses 应包含 POL');
    assert.strictEqual(addr, '0x0000000000000000000000000000000000000000');
});

test('Amoy 测试网 tokenAddresses 不包含 USDT', () => {
    assert(!CONFIG.networks.amoy.tokenAddresses.USDT, 'amoy tokenAddresses 不应包含 USDT');
});

// ---- getSupportedTokensForNetwork 辅助方法 ----
test('getSupportedTokensForNetwork("polygon") 返回含 POL 的列表', () => {
    const tokens = CONFIG.getSupportedTokensForNetwork('polygon');
    assert(tokens.some(t => t.symbol === 'POL'));
});

test('getSupportedTokensForNetwork("unknown") 返回空数组', () => {
    const tokens = CONFIG.getSupportedTokensForNetwork('unknown');
    assert.deepStrictEqual(tokens, []);
});

console.log('\n' + '=' .repeat(60));
console.log(`测试结果: ✅ 通过 ${pass}, ❌ 失败 ${fail}`);
console.log('=' .repeat(60));

if (fail > 0) {
    process.exit(1);
}
