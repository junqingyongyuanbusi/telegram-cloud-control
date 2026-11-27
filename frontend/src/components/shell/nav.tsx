/**
 * 侧栏导航配置：树形结构（分组 → 菜单项 → 子菜单）。
 *
 * 结构约定：
 * - `NavGroup` 是一级分组（总览 / 账号 / 消息 / 运营），分组标题可折叠；
 * - `NavItem` 可以是叶子（有 path，点击跳转），也可以带 `children`（点击只展开子菜单）；
 * - 触达中心是唯一的三级菜单：分组「运营」→ 触达中心 → 素材库 / 群发 / 素材群发 / 加群 / 批次进度，
 *   每个子项是独立路由 `/campaigns/<section>`，页面内不再堆 Tab。
 *
 * 兼容导出：`NAV_ITEMS` 是全部叶子（全局搜索、全局搜索的结果列表用它）。
 * 角色裁剪：`visibleNavGroups` / `visibleNavItems` 按 `navAccess.ts` 的策略过滤，
 * 侧栏与全局搜索都用它们；`NAV_GROUPS` / `NAV_ITEMS` 仍是完整清单（面包屑、匹配用）。
 */
import type { ReactNode } from 'react';
import {
  ApiOutlined,
  AppstoreOutlined,
  DashboardOutlined,
  FileSearchOutlined,
  FolderOutlined,
  RadarChartOutlined,
  MailOutlined,
  MergeCellsOutlined,
  MessageOutlined,
  ProfileOutlined,
  RocketOutlined,
  ScheduleOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { Tone } from '../../constants';
import { canVisitPath } from './navAccess';

export type NavBadgeSource = 'abnormal' | 'unread' | 'failed' | 'pending';

export interface NavItem {
  path: string;
  label: string;
  /** i18n key in shell namespace (e.g. 'nav.items.dashboard') */
  labelKey: string;
  icon?: ReactNode;
  /** 一句话说明：面包屑 / 全局搜索 / 无权限提示都会用到 */
  description?: string;
  descriptionKey?: string;
  badge?: NavBadgeSource;
  badgeTone?: Tone;
  /** 子菜单：给 children 时该项本身不跳转，只负责展开 */
  children?: NavItem[];
}

export interface NavGroup {
  key: string;
  title: string;
  titleKey: string;
  items: NavItem[];
}

/** 触达中心当前开放的 3 个子页面（三级菜单，独立路由）
 *  「加群群发」合并了原来的 群发 / 素材群发 / 加群：一个号一条任务，逐群加群并当场发内容。
 *  批量私信 / 退群 / 强拉进群 / 批量改资料 / 吵群 / 拟人发言 与旧的三个入口已下线：
 *  这里不列、Campaigns 页的 sections 也不渲染，旧地址会重定向到素材库。 */
export const CAMPAIGN_CHILDREN: NavItem[] = [
  {
    path: '/campaigns/materials',
    label: '素材库',
    labelKey: 'nav.items.campaignsMaterials',
    icon: <FolderOutlined />,
    description: '文字与媒体素材，批量动作共用',
    descriptionKey: 'nav.items.campaignsMaterialsDesc',
  },
  {
    path: '/campaigns/join-send',
    label: '加群群发',
    labelKey: 'nav.items.campaignsJoinSend',
    icon: <MergeCellsOutlined />,
    description: '逐群「加群 → 过验证 → 发内容」，一个号一条任务',
    descriptionKey: 'nav.items.campaignsJoinSendDesc',
  },
  {
    path: '/campaigns/batches',
    label: '批次进度',
    labelKey: 'nav.items.campaignsBatches',
    icon: <ProfileOutlined />,
    description: '按批次查进度、取消未完成任务',
    descriptionKey: 'nav.items.campaignsBatchesDesc',
  },
];

export const NAV_GROUPS: NavGroup[] = [
  {
    key: 'overview',
    title: '总览',
    titleKey: 'nav.groups.overview',
    items: [
      {
        path: '/',
        label: '工作台',
        labelKey: 'nav.items.dashboard',
        icon: <DashboardOutlined />,
        description: '在线数、异常数、失败任务',
        descriptionKey: 'nav.items.dashboardDesc',
      },
    ],
  },
  {
    key: 'accounts',
    title: '账号',
    titleKey: 'nav.groups.accounts',
    items: [
      {
        path: '/accounts',
        label: '账号管理',
        labelKey: 'nav.items.accounts',
        icon: <UserOutlined />,
        description: '状态、分组、心跳、当前任务、单号检测',
        descriptionKey: 'nav.items.accountsDesc',
        badge: 'abnormal',
        badgeTone: 'danger',
      },
      {
        path: '/groups',
        label: '账号分组',
        labelKey: 'nav.items.groups',
        icon: <AppstoreOutlined />,
        description: '自定义标签，用来把号分给同事',
        descriptionKey: 'nav.items.groupsDesc',
      },
      {
        path: '/network',
        label: '网络',
        labelKey: 'nav.items.network',
        icon: <ApiOutlined />,
        description: '账号出站地址（代理）',
        descriptionKey: 'nav.items.networkDesc',
      },
    ],
  },
  {
    key: 'messages',
    title: '消息',
    titleKey: 'nav.groups.messages',
    items: [
      {
        path: '/inbox',
        label: '客服收件箱',
        labelKey: 'nav.items.inbox',
        icon: <MailOutlined />,
        description: '跨账号汇总待处理私信，未读优先，点进去直接回复',
        descriptionKey: 'nav.items.inboxDesc',
      },
      {
        path: '/dialogs',
        label: '会话',
        labelKey: 'nav.items.dialogs',
        icon: <MessageOutlined />,
        description: '群聊和私信',
        descriptionKey: 'nav.items.dialogsDesc',
        badge: 'unread',
        badgeTone: 'info',
      },
      {
        path: '/group-intel',
        label: '群情报',
        labelKey: 'nav.items.groupIntel',
        icon: <RadarChartOutlined />,
        description: '入群即采：群档案、成员名单与入退群流水',
        descriptionKey: 'nav.items.groupIntelDesc',
      },
    ],
  },
  {
    key: 'ops',
    title: '运营',
    titleKey: 'nav.groups.ops',
    items: [
      {
        path: '/tasks',
        label: '任务中心',
        labelKey: 'nav.items.tasks',
        icon: <ScheduleOutlined />,
        description: '同步、单条发送、转发，含失败原因与重试次数',
        descriptionKey: 'nav.items.tasksDesc',
        badge: 'failed',
        badgeTone: 'danger',
      },
      {
        path: '/campaigns',
        label: '触达中心',
        labelKey: 'nav.items.campaigns',
        icon: <RocketOutlined />,
        description: '批量私信、群发、素材、加退群、强拉、改资料、吵群、拟人发言',
        descriptionKey: 'nav.items.campaignsDesc',
        children: CAMPAIGN_CHILDREN,
      },
      {
        path: '/assignments',
        label: '员工分配',
        labelKey: 'nav.items.assignments',
        icon: <TeamOutlined />,
        description: '谁可以操作哪个号',
        descriptionKey: 'nav.items.assignmentsDesc',
      },
      {
        path: '/audit',
        label: '操作记录',
        labelKey: 'nav.items.audit',
        icon: <FileSearchOutlined />,
        description: '谁在什么时间对哪个号做了什么',
        descriptionKey: 'nav.items.auditDesc',
      },
    ],
  },
];

/** 全部叶子项（递归展开；全局搜索 / 快捷键跳转用它） */
export const NAV_ITEMS: NavItem[] = (() => {
  const leaves: NavItem[] = [];
  const walk = (items: NavItem[]) => {
    items.forEach((item) => {
      if (item.children?.length) walk(item.children);
      else leaves.push(item);
    });
  };
  NAV_GROUPS.forEach((group) => walk(group.items));
  return leaves;
})();

/** 按角色裁剪后的导航树：operator 只会拿到消息（会话/群情报）与运营（任务/触达） */
export function visibleNavGroups(isAdmin: boolean): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items
      .filter((item) =>
        item.children?.length
          ? item.children.some((child) => canVisitPath(child.path, isAdmin))
          : canVisitPath(item.path, isAdmin),
      )
      .map((item) =>
        item.children?.length
          ? { ...item, children: item.children.filter((child) => canVisitPath(child.path, isAdmin)) }
          : item,
      ),
  })).filter((group) => group.items.length > 0);
}

/** 按角色裁剪后的全部叶子项（全局搜索的「页面」结果用它） */
export function visibleNavItems(isAdmin: boolean): NavItem[] {
  const leaves: NavItem[] = [];
  const walk = (items: NavItem[]) => {
    items.forEach((item) => {
      if (item.children?.length) walk(item.children);
      else leaves.push(item);
    });
  };
  visibleNavGroups(isAdmin).forEach((group) => walk(group.items));
  return leaves;
}

export interface NavMatch {
  group: NavGroup;
  /** 命中的叶子项 */
  item: NavItem;
  /** 从分组到叶子的完整链（含分组标题），面包屑用它 */
  trail: NavItem[];
}

function collectTrail(items: NavItem[], pathname: string, parents: NavItem[]): NavItem[] | null {
  for (const item of items) {
    const chain = [...parents, item];
    if (item.children?.length) {
      const found = collectTrail(item.children, pathname, chain);
      if (found) return found;
      continue;
    }
    if (item.path === '/') {
      if (pathname === '/') return chain;
      continue;
    }
    if (pathname === item.path || pathname.startsWith(`${item.path}/`)) return chain;
  }
  return null;
}

/** 按当前路径找命中链：最长的 path 优先（避免 /campaigns 抢 /campaigns/materials） */
export function matchNavTrail(pathname: string): NavMatch | undefined {
  let best: { group: NavGroup; trail: NavItem[] } | undefined;
  NAV_GROUPS.forEach((group) => {
    const trail = collectTrail(group.items, pathname, []);
    if (!trail) return;
    const leaf = trail[trail.length - 1];
    const current = best ? best.trail[best.trail.length - 1] : undefined;
    if (!current || leaf.path.length > current.path.length) best = { group, trail };
  });
  if (!best) return undefined;
  const item = best.trail[best.trail.length - 1];
  return { group: best.group, item, trail: best.trail };
}

/** 兼容旧调用：只取分组与叶子项 */
export function matchNav(pathname: string): { group: NavGroup; item: NavItem } | undefined {
  const matched = matchNavTrail(pathname);
  return matched ? { group: matched.group, item: matched.item } : undefined;
}

/** 该路径所属的分组 key 与父级路径（侧栏据此默认展开） */
export function parentsOf(pathname: string): string[] {
  const matched = matchNavTrail(pathname);
  if (!matched) return [];
  return matched.trail.slice(0, -1).map((node) => node.path);
}
