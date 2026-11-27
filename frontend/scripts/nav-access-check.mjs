/**
 * 回归：页面权限策略（运营商角色只能看到 会话 / 群情报 / 任务中心 / 触达中心）。
 *
 * 策略本体是 frontend/src/components/shell/navAccess.ts，侧栏、全局搜索、
 * 路由守卫（App.tsx 的 RequireAdmin / AdminHome）都走它。这里直接断言纯函数，
 * 不依赖浏览器，也不需要起栈：
 *     cd frontend && npm run check:nav-access
 */
import { ADMIN_ONLY_PATHS, OPERATOR_HOME, canVisitPath } from '../src/components/shell/navAccess.ts';

const OPERATOR_ALLOWED = [
  '/tasks',
  '/campaigns',
  '/campaigns/materials',
  '/campaigns/join-send',
  '/campaigns/batches',
  '/dialogs',
  '/group-intel',
];

const OPERATOR_DENIED = [
  '/',
  '/inbox',
  '/accounts',
  '/accounts/123',
  '/groups',
  '/network',
  '/assignments',
  '/audit',
  '/audit/abc',
  '/__components',
];

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

console.log('operator 可见页面');
for (const path of OPERATOR_ALLOWED) {
  check(`operator 可以访问 ${path}`, canVisitPath(path, false));
}

console.log('operator 不可见页面');
for (const path of OPERATOR_DENIED) {
  check(`operator 被拒绝 ${path}`, !canVisitPath(path, false));
}

console.log('admin 全部可见');
for (const path of [...ADMIN_ONLY_PATHS, ...OPERATOR_ALLOWED]) {
  check(`admin 可以访问 ${path}`, canVisitPath(path, true));
}

console.log('策略自洽性');
check('operator 落地页在可见范围内', canVisitPath(OPERATOR_HOME, false), OPERATOR_HOME);
check(
  'ADMIN_ONLY_PATHS 对 operator 全部拒绝',
  ADMIN_ONLY_PATHS.every((path) => !canVisitPath(path, false)),
);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
