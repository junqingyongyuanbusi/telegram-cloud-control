/**
 * 登录页「记住用户名」的本地存储。
 * 只存用户名，不存口令；口令永远不进 localStorage。
 */
const REMEMBER_KEY = 'tgcc_remember_username';

export function readRememberedUsername(): string {
  try {
    return window.localStorage.getItem(REMEMBER_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeRememberedUsername(username: string | null): void {
  try {
    if (username) window.localStorage.setItem(REMEMBER_KEY, username);
    else window.localStorage.removeItem(REMEMBER_KEY);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}
