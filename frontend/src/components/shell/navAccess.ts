/**
 * 页面可见性策略 —— 前端唯一权限清单（侧栏、全局搜索、路由守卫共用）。
 *
 * 角色只有两种（后端 `app/models/enums.py`）：
 * - admin：全部页面；
 * - operator：消息（会话、群情报）+ 运营（任务中心、触达中心），
 *   其余（工作台、客服收件箱、账号/分组/网络、员工分配、操作记录）一律不可见。
 *
 * 这里是纯函数、不依赖 React，`frontend/scripts/nav-access-check.mjs` 直接跑它做回归。
 * 新增管理员页面时：把路径加进 ADMIN_ONLY_PATHS，并在 App.tsx 用 <RequireAdmin> 包住路由。
 */

/** 只有 admin 能访问的路径前缀（精确匹配或以 `<path>/` 开头） */
export const ADMIN_ONLY_PATHS: readonly string[] = [
  '/', // 工作台
  '/inbox', // 客服收件箱
  '/accounts', // 账号管理
  '/groups', // 账号分组
  '/network', // 网络（代理）
  '/assignments', // 员工分配
  '/audit', // 操作记录
  '/__components', // 开发环境组件预览（App.tsx 同样用 RequireAdmin 包住）
];

/** operator 登录后的落地页 */
export const OPERATOR_HOME = '/tasks';

/** 当前角色能否访问该路径（页面级判断；接口鉴权仍以后端为准） */
export function canVisitPath(pathname: string, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  return !ADMIN_ONLY_PATHS.some((path) =>
    path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`),
  );
}
