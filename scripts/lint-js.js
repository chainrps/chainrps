/**
 * ChainRPS 前端 JS 静态语法检查脚本
 *
 * 零依赖：仅使用 Node 内置的 vm/checkVM（通过 spawn 调用 node --check）
 * 用途：本地/CI 快速验证 rps_frontend/static/js/ 下所有 .js 是否有语法错误
 *
 * 用法：
 *   node scripts/lint-js.js          # 默认：仅检查前端静态资源目录
 *   node scripts/lint-js.js --check  # 严格模式：发现错误立即退出 1
 *   node scripts/lint-js.js --all    # 检查前端 + 后端 + 脚本所有 .js 文件
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const checkMode = args.includes('--check');
const allMode = args.includes('--all');

// ==================== 检查目标目录 ====================

const FRONTEND_JS_DIRS = [
    'rps_frontend/static/js',
    'rps_frontend/web/static/js',  // 兼容旧目录
];

const BACKEND_JS_DIRS = [
    'rps_backend',  // 若后端有 JS 工具脚本
];

const SCRIPT_JS_DIRS = [
    'scripts',
    'contracts/scripts',
];

/**
 * 递归收集目录下所有 .js 文件
 */
function collectJsFiles(dirPath, result = []) {
    if (!existsSync(dirPath)) return result;
    const entries = readdirSync(dirPath);
    for (const entry of entries) {
        const fullPath = join(dirPath, entry);
        let stat;
        try {
            stat = statSync(fullPath);
        } catch {
            continue;
        }
        if (stat.isDirectory()) {
            // 跳过 node_modules、.git、__pycache__ 等
            if (['node_modules', '.git', '__pycache__', 'dist', 'build'].includes(entry)) {
                continue;
            }
            collectJsFiles(fullPath, result);
        } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
            result.push(fullPath);
        }
    }
    return result;
}

/**
 * 把路径转回 POSIX 风格（统一展示）
 */
function toPosix(p) {
    return p.split(sep).join('/');
}

// ==================== 主流程 ====================

let targetDirs = [...FRONTEND_JS_DIRS];
if (allMode) {
    targetDirs = [...FRONTEND_JS_DIRS, ...BACKEND_JS_DIRS, ...SCRIPT_JS_DIRS];
}

const allFiles = [];
for (const dir of targetDirs) {
    const fullDir = join(PROJECT_ROOT, dir);
    const files = collectJsFiles(fullDir);
    allFiles.push(...files);
}

// 去重
const uniqueFiles = Array.from(new Set(allFiles));

if (uniqueFiles.length === 0) {
    console.log('⚠️  未找到任何 .js 文件。请检查目录配置。');
    process.exit(0);
}

console.log(`🔍 准备检查 ${uniqueFiles.length} 个 JS 文件...`);
console.log(`   目标目录: ${targetDirs.join(', ')}`);
console.log(`   模式: ${allMode ? '全部(含后端/脚本)' : '仅前端静态资源'}`);
console.log('');

let passCount = 0;
let failCount = 0;
const failedFiles = [];

for (const file of uniqueFiles) {
    const relPath = toPosix(relative(PROJECT_ROOT, file));
    const result = spawnSync(process.execPath, ['--check', file], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.status === 0) {
        passCount++;
        console.log(`  ✅ ${relPath}`);
    } else {
        failCount++;
        failedFiles.push({ file: relPath, stderr: result.stderr || result.stdout || '' });
        console.log(`  ❌ ${relPath}`);
        if (checkMode) {
            console.log('');
            console.log(result.stderr || result.stdout || '(无错误输出)');
            console.log('');
            console.log(`❌ 严格模式：发现语法错误，立即退出。`);
            process.exit(1);
        }
    }
}

console.log('');
console.log('========================================');
console.log(`✅ 通过: ${passCount}`);
console.log(`❌ 失败: ${failCount}`);
console.log(`📊 总计: ${passCount + failCount}`);
console.log('========================================');

if (failCount > 0) {
    console.log('');
    console.log('失败文件列表:');
    for (const { file, stderr } of failedFiles) {
        console.log(`  - ${file}`);
        if (stderr) {
            const lines = stderr.split('\n').filter((l) => l.trim()).slice(0, 3);
            for (const line of lines) {
                console.log(`      ${line}`);
            }
        }
    }
    process.exit(1);
}

process.exit(0);
