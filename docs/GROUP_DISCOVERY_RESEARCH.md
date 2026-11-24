# Telegram 群组发现研究：关键词 + 地区（马来西亚 / Forex / Trading / Gold）

> 调研时间：2026-11-23
> 调研范围：Telegram 官方 API 文档、当前 TL schema、TDLib 文档、Telegram Desktop 源码、开源项目源码与 README。
> 结论先行：**Telegram 没有“按国家/地区搜索群组”的官方能力**。地区只能作为本地推断字段和本地过滤条件；`contacts.search` 只是一个单页的公开 peer 查找接口，不是群组目录。

## 1. 结论摘要

1. `contacts.search` 的真实能力被高估了：官方 method 页写的是“按 username 子串返回 users”，TDLib 的 `searchPublicChats` 文档写的是“在 username 和 title 中查找公开聊天”，但两者都不搜索 `about`、不搜索历史消息，也**没有 offset/分页参数**，只有 `q` 和 `limit` 两个输入。([method/contacts.search](https://core.telegram.org/method/contacts.search), [td_api.tl L13055-L13067](https://github.com/tdlib/td/blob/master/td/generate/scheme/td_api.tl#L13055-L13067))
2. 它还会**排除当前账号的联系人**，且**只允许用户账号调用**（bots 不可用）。([method/contacts.search](https://core.telegram.org/method/contacts.search))
3. `messages.searchGlobal(groups_only=True)` 是“全局消息搜索”，返回的是消息和命中的 peer，不是群组列表；`groups_only` 只是把消息命中限制在群组类型，**没有国家参数**。它支持 `offset_rate/offset_peer/offset_id` 翻页，适合做“从消息反查群”，不适合做目录。([method/messages.searchGlobal](https://core.telegram.org/method/messages.searchGlobal))
4. `channels.searchPosts` 只在**公开频道**里搜帖子，且全球搜索是付费的（Premium 有免费额度，之后按 Stars 计费），**不覆盖群组**。([method/channels.searchPosts](https://core.telegram.org/method/channels.searchPosts), [api/search](https://core.telegram.org/api/search))
5. `contacts.getSponsoredPeers` 返回的是赞助广告结果，不是自然目录。`contacts.getLocated` 只能按经纬度找“附近”的用户和 geogroup，不是国家筛选。([method/contacts.getSponsoredPeers](https://core.telegram.org/method/contacts.getSponsoredPeers), [api/nearby](https://core.telegram.org/api/nearby))
6. 唯一和“地区”沾边的官方字段是 geochat 的 `channelFull.location` / `channel.has_geo`，它描述单个超级群的地理位置，**不是搜索过滤条件**，而且绝大多数群不是 geochat。([constructor/channelFull](https://core.telegram.org/constructor/channelFull), [constructor/channel](https://core.telegram.org/constructor/channel))
7. `t.me/s/<username>` 只对**广播频道**有帖子预览；公开超级群的 `t.me/<username>` 能拿到标题、成员数、头像，但**不暴露 about**。`t.me` 页面是离线补充元数据的好来源，但不能替代搜索。本文的实测见 3.6。
8. 可落地的路线是混合式：**在线种子搜索（contacts.search + 消息搜索）→ t.me/邀请链接补全 → 已加入群的图扩展 → 本地地区分类 → Postgres 全文/模糊索引 → 提交入口与定期复核**。开源项目里没有现成的“关键词 + 马来西亚”方案；最接近的 crawler 也都不做地区过滤。

## 2. 现状与根因

### 2.1 当前实现

当前入口是 `backend/app/worker/group_intel.py:343` 的 `_search_groups`：

```python
res = await client(functions.contacts.SearchRequest(q=keyword, limit=per_keyword))
```

调用点在 `backend/app/worker/group_intel.py:366`。请求模型在 `backend/app/schemas/group_intel.py:217`：

- `keywords` 最多 20 个；
- `per_keyword` 限制在 1..100，默认 50；
- `min_members` 默认 0；
- `kind` 可选 `any/group/channel`。

代码只遍历 `res.chats`，按 `megagroup`/`broadcast` 判断类型，按成员数和类型过滤，然后 `upsert_profile`，`source="keyword_search"`；每个关键词之间 sleep 2–5 秒。没有分页，没有地区参数，没有查询扩展，也没有跨账号去重。

当前 API 的搜索是 `backend/app/api/routers/group_intel.py:545`：

```python
GroupProfile.title.ilike(f"%{q}%")
| GroupProfile.username.ilike(f"%{q}%")
| GroupProfile.about.ilike(f"%{q}%")
```

即 `ILIKE '%q%'`，没有全文索引，也没有地区字段。`GroupProfile` 的唯一键是 `(account_id, tg_chat_id)`（`backend/app/models/group_intel.py:90`），所以同一个群在不同账号下会重复存储，难以做全局目录。

### 2.2 为什么 “Forex / trading / Gold” 结果很少

按影响从大到小：

1. **单页上限，不能翻页。** `contacts.search` 的 TL 只有 `q` 和 `limit`，没有 `offset`。([telegram_api.tl L2645](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L2645)) 你请求 50，最多拿到一页 50 个；如果全局排序把尼日利亚、印度、印尼的大频道排在前面，马来西亚的小群根本进不了这一页。`limit` 的官方最大值没有文档，客户端通常请求 20–50（tg-radar 默认 20，见 [config.py:30](https://github.com/bigidulka/tg-radar/blob/master/src/tg_radar/config.py#L30)）。
2. **匹配面太窄。** 官方 method 页写“Returns users found by username substring”；TDLib 文档写“username and title”。两者都不搜 `about`、不搜消息内容。一个叫 “FX Warrior MY” 的群，标题里没有 “Forex”，就搜不到；一个叫 “Trading Hub” 的群，简介里写了 “Malaysia”，也搜不到。([method/contacts.search](https://core.telegram.org/method/contacts.search), [td_api.tl L13055-L13067](https://github.com/tdlib/td/blob/master/td/generate/scheme/td_api.tl#L13055-L13067))
3. **联系人被排除。** 官方明确说 “This method will exclude the current user's contacts from the search results.” 如果运营账号已经加了很多目标群主/成员为联系人，这些人的群会被排除。([method/contacts.search](https://core.telegram.org/method/contacts.search))
4. **没有地区约束。** `Forex`、`Gold` 是全球通用词，服务端不会按国家排序；`Gold` 还会命中 Gold Coast、Goldman、金价频道等无关结果。你看到的“少量”往往是全球头部结果，不是马来西亚结果。
5. **`min_members` 会把本地小群滤掉。** 马来西亚很多本地交易群只有几百到几千人；如果任务里设置了 `min_members=10000`，结果自然接近 0。
6. **账号/服务端风控。** 新号、受限号、同一账号高频调用时，服务端可能返回更少结果甚至空结果。官方没有公布排序和限额，这一点只能标为 **unverified**；但 `FLOOD_WAIT` 和账号观察期是官方明确存在的。([api/errors](https://core.telegram.org/api/errors), [api/obtaining_api_id](https://core.telegram.org/api/obtaining_api_id))
7. **“实时且无反爬”的说法只对了一半。** 不抓网页不等于没有服务端限制；`contacts.search` 本身有单页、联系人排除、用户账号限定，并不是目录型接口。`docs/COMPETITOR_ANALYSIS.md:99` 自己记录端到端只找到 3 个群，这和“单页低召回”是一致的。

### 2.3 这不是“加一个 `region` 参数”能解决的问题

`contacts.search` 的 TL 没有地区字段；`messages.searchGlobal` 只有 `broadcasts_only/groups_only/users_only/folder_id/community`；`channels.searchPosts` 只有 `hashtag/query/offset/allow_paid_stars`。三者都没有 country/region。([telegram_api.tl L2645](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L2645), [L2714](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L2714), [L3036](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L3036))

因此，地区必须是**本地字段 + 本地分类器 + 本地过滤**，而不是 API 参数。这一点是后面所有架构决策的前提。

## 3. 官方 API 能力与硬限制

### 3.1 `contacts.search`

**TL（当前 schema）：**

```tl
contacts.search#5f58d0f flags:# broadcasts:flags.0?true bots:flags.1?true
  q:string limit:int = contacts.Found;
```

来源：[telegram_api.tl L2645](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L2645)。旧版/文档页可能是 `contacts.search#11f812d8 q:string limit:int`，但输入仍然是 `q + limit`，没有 offset。

**官方文档原文要点：**

- “Returns users found by username substring.”
- `q`：Target substring；`limit`：Maximum number of users to be returned。
- “This method will exclude the current user's contacts from the search results. It is assumed that searches among the user's contacts can be handled locally by the client.”
- “Only users can use this method.”
- 错误：`QUERY_TOO_SHORT`、`SEARCH_QUERY_EMPTY`。

来源：[method/contacts.search](https://core.telegram.org/method/contacts.search)。

**硬限制：**

| 项目 | 事实 | 依据 |
| --- | --- | --- |
| 分页 | 没有 offset/hash，单次调用就是一页 | TL 签名 |
| 最大 limit | 官方未公布；`limit:int` 单页，客户端常用 20–50 | TL + tg-radar 默认 20 |
| 查询长度 | 没有文档化的最小长度；1–2 字符可能触发 `QUERY_TOO_SHORT` | 官方 errors |
| 联系人 | 当前账号的联系人被排除 | 官方文档 |
| 账号类型 | 仅用户账号；bots 不可用 | 官方文档 |
| 匹配字段 | 官方说 username 子串；TDLib 说 username + title；都不含 about/消息 | 官方文档 + TDLib |
| 账号作用域 | 结果属于调用账号的 session；`Found` 同时返回 `my_results` 和 `results` | TL/文档 |

`contacts.Found` 里有 `my_results`、`results`、`chats`、`users`，所以它确实能返回 chats；但“能返回”不等于“能枚举”。服务端只给你一页，且排序逻辑不公开。

### 3.2 `messages.searchGlobal`

**TL（当前 schema）：**

```tl
messages.searchGlobal#6126a43c flags:#
  broadcasts_only:flags.1?true groups_only:flags.2?true users_only:flags.3?true
  folder_id:flags.0?int community:flags.4?InputChannel
  q:string filter:MessagesFilter min_date:int max_date:int
  offset_rate:int offset_peer:InputPeer offset_id:int limit:int
  = messages.Messages;
```

来源：[telegram_api.tl L2714](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L2714)。

**文档要点：**

- `groups_only`：“Whether to search only in groups”；
- `broadcasts_only`：“only returns results from channels (used in the global channel search tab)”；
- `users_only`：只搜私聊；
- 分页：`offset_rate` 首次传 0，之后用 `messages.messagesSlice.next_rate` 或最后一条消息的日期；`offset_peer`/`offset_id` 按 [api/offsets](https://core.telegram.org/api/offsets)；
- “Only users can use this method”；
- 错误：`FOLDER_ID_INVALID`、`INPUT_FILTER_INVALID`、`SEARCH_QUERY_EMPTY`。

来源：[method/messages.searchGlobal](https://core.telegram.org/method/messages.searchGlobal)。

**它不是什么：**

- 不返回“群组列表”，返回的是消息和命中 peer；
- `groups_only` 只是类型过滤，不是“群组目录”；
- 没有国家/地区参数；
- 是否覆盖“所有公开群”没有官方保证。官方搜索页只说 Chats tab 用 `messages.searchGlobal`，Channels tab 用 `broadcasts_only`，没有承诺全量索引。([api/search](https://core.telegram.org/api/search)) 这一点标为 **unverified**。

### 3.3 `channels.searchPosts`

**TL：**

```tl
channels.searchPosts#f2c4f24d flags:#
  hashtag:flags.0?string query:flags.1?string
  offset_rate:int offset_peer:InputPeer offset_id:int limit:int
  allow_paid_stars:flags.2?long = messages.Messages;
```

来源：[telegram_api.tl L3036](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L3036)。

**文档要点：**

- “Globally search for posts from public channels (including those we aren't a member of) containing either a specific hashtag, or a full text query. Exactly one of query and hashtag must be set.”
- 全球帖子搜索是付费的：Premium 用户有免费额度，之后每次搜索消耗 Stars；先调 `channels.checkSearchPostsFlood` 获取 `total_daily/remains/wait_till/stars_amount/query_is_free`；首次搜索后的翻页免费。
- 只覆盖**公开频道**，不覆盖群组。

来源：[method/channels.searchPosts](https://core.telegram.org/method/channels.searchPosts), [api/search](https://core.telegram.org/api/search)。

**用途**：如果你要做“频道目录”，它可以从帖子正文反查频道；对“群组目录”帮助有限。它可以作为 channels 侧的补充信号，但不能替代群组发现。

### 3.4 `contacts.getSponsoredPeers`

```tl
contacts.getSponsoredPeers#b6c8c393 q:string = contacts.SponsoredPeers;
```

“Obtain a list of sponsored peer search results for a given query.” 这是广告位结果，不是自然搜索；只有 `q`，没有地区。([method/contacts.getSponsoredPeers](https://core.telegram.org/method/contacts.getSponsoredPeers))

### 3.5 其他“看起来像目录”的方法

| 方法 | 实际用途 | 是否目录 | 地区 | 备注 |
| --- | --- | --- | --- | --- |
| `contacts.resolveUsername` | 把已知 username 解析成 peer | 否 | 无 | 不能搜索，只能解析已知名字；users/bots 均可用。([method/contacts.resolveUsername](https://core.telegram.org/method/contacts.resolveUsername)) |
| `channels.getFullChannel` | 获取频道/超级群的 about、成员数、`location` | 否 | 仅 geochat 的 `location` | 文档说 users/bots 均可用；私有群需要访问权。([method/channels.getFullChannel](https://core.telegram.org/method/channels.getFullChannel)) |
| `messages.checkChatInvite` | 预览邀请链接的 title/about/participants_count | 否 | 无 | 需要有效 invite hash；`chatInviteAlready` 表示已加入。([method/messages.checkChatInvite](https://core.telegram.org/method/messages.checkChatInvite)) |
| `contacts.getLocated` | 按经纬度找附近用户和 geogroup | 否 | 仅 proximity | 文档描述为 nearby；当前客户端是否仍提供该功能未验证。([api/nearby](https://core.telegram.org/api/nearby)) |
| [`messages.getCommonChats`](https://core.telegram.org/method/messages.getCommonChats) | 与某个用户的共同群 | 否 | 无 | 需要已知用户，适合图扩展，不是搜索。 |
| [`channels.getGroupsForDiscussion`](https://core.telegram.org/method/channels.getGroupsForDiscussion) | 可作为讨论组的群 | 否 | 无 | 不是“相关群”推荐；`channelFull.linked_chat_id` 才是已链接群。 |
| [`messages.getDialogs`](https://core.telegram.org/method/messages.getDialogs) | 当前账号已加入的会话 | 否 | 无 | 只能看到自己已加入的群。 |

### 3.6 `t.me` 页面实测（2026-11-23）

用 `curl -L` 对公开页面做了两组对照：

| URL | 结果 | 能拿到什么 |
| --- | --- | --- |
| `https://t.me/durov` | 200 | `og:title`、`og:description`（频道 about）、`tgme_page_extra` 订阅数、加入按钮 |
| `https://t.me/s/durov` | 200 | 20 条 `tgme_widget_message_wrap` 帖子；无加入按钮 |
| `https://t.me/tdlibchat` | 200 | `og:title`、`og:description` 是通用句 “You can view and join @tdlibchat right away.”、`tgme_page_extra` “8 357 members, 294 online” |
| `https://t.me/s/tdlibchat` | 302 到 `t.me/tdlibchat` | 没有帖子预览 |

结论：

- `t.me/s/<username>` 对**广播频道**有效，对**公开超级群无效**；这是实测行为，官方没有文档保证，标为 empirical。
- `t.me/<username>` 对公开频道/超级群都能拿到标题、成员数、头像；**群组的 about 不暴露**（频道才暴露）。
- `t.me/s` 每页约 20 条；`?before=<id>` 是常见的翻页参数，但本次没有逐页验证，标为 **unverified**。它适合抓频道帖子，不适合抓群成员。
- 基本群没有公开 username，`t.me/<username>` 不适用。官方邀请文档明确：“Only supergroups and channels may have public usernames: normal groups must be migrated to a supergroup before they can be assigned a username.”([api/invites](https://core.telegram.org/api/invites))

### 3.7 官方有没有地区过滤？

**没有。** 逐个检查：

- `contacts.search`：只有 `q`、`limit`。
- `messages.searchGlobal`：只有 `broadcasts_only/groups_only/users_only/folder_id/community/q/filter/date/offset/limit`。
- `channels.searchPosts`：只有 `hashtag/query/offset/allow_paid_stars`。
- `contacts.getSponsoredPeers`：只有 `q`。
- `contacts.getLocated`：只有 `geo_point`、`self_expires`、`background`。
- `channelFull.location` / `channel.has_geo`：是单个 geochat 的属性，不是搜索参数。

唯一能算“地区”的官方能力是 geochat：`channels.createChannel` 可以带 `geo_point`/`address`，`channels.editLocation` 可以改位置，`contacts.getLocated` 可以找附近的 geogroup。([api/nearby](https://core.telegram.org/api/nearby)) 但 geochat 是极少数，且 `getLocated` 是“附近”不是“国家”，不能用来枚举马来西亚的普通群。

### 3.8 用户账号 vs bot：地区信号的真实可用性

| 信号 | 用户账号 | Bot | 说明 |
| --- | --- | --- | --- |
| 群标题 / about | 公开群/已加入群可用 | Bot API `getChat` 对已知公开 chat 可能可用；无全局搜索 | 最强文本信号 |
| 成员 `lang_code` | **不可用**（TDLib 明确写 “only available to bots”） | 可用（bot 看到的 user） | 用户账号不能靠成员语言做地区推断 |
| 成员手机号国家 | 受隐私设置限制；通常仅联系人或自己可见；普通成员不保证有 `phone` | 不能枚举成员 | 不可规模化 |
| `channelFull.location` | geochat 可用 | 取决于访问权 | 极少数群 |
| `t.me` 页面 | 可用 | 可用 | 标题/成员数/频道 about |
| 邀请链接 `chatInvite.about` | 可用（有效 hash） | 未验证 | 只有 title/about/count，无国家 |
| 共同群/图关系 | 已加入群可用 | 不可用 | 适合扩展，不适合冷启动 |
| 消息内容 | 已加入/公开频道可用 | 不可用 | 城市、货币、语言线索 |
| 外部目录分类 | 可用 | 可用 | 质量取决于目录 |

关键细节：

- TL `user` 有 `phone:flags.4?string`、`lang_code:flags.22?string`，但**没有 country_code 字段**。([telegram_api.tl L117](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L117))
- TDLib 的 `user.language_code` 注释是 “IETF language tag of the user's language; only available to bots”。([td_api.tl L3161-L3163](https://github.com/tdlib/td/blob/master/td/generate/scheme/td_api.tl#L3161-L3163))
- `accountInfo.phone_number_country_code` 确实存在，但它是“另一个与当前用户发起聊天的用户”的手机号国家码，属于账号信息上下文，不是群成员字段。([td_api.tl L4428-L4430](https://github.com/tdlib/td/blob/master/td/generate/scheme/td_api.tl#L4428-L4430))
- `channels.getFullChannel` 的 `channelFull` 有 `about`、`participants_count`、`location:flags.15?ChannelLocation`；`ChannelLocation` 是 `geo_point + address`。([telegram_api.tl L138](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L138), [L1373](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L1373))
- Bot API 没有 `contacts.search` 这类全局搜索；bot 也不能枚举群成员。([bots/api](https://core.telegram.org/bots/api)) 具体 `getChat` 对非成员群的字段覆盖，本文标为 **unverified**。

**结论**：对用户账号来说，可规模化的地区信号只有“文本 + 图关系 + t.me/邀请元数据 + 外部目录”；成员语言和手机号国家基本不可用。任何声称“按成员手机号国家筛群”的方案，在用户账号上都不成立。

## 4. 地区过滤的现实做法

### 4.1 可用信号与强度

| 信号 | 来源 | 覆盖 | 强度 | 备注 |
| --- | --- | --- | --- | --- |
| 标题/简介中的国家、城市、货币 | `GetFullChannel` / `t.me` / 消息 | 中 | 高 | “Malaysia/MY/KL/Bursa/MYR/RM/Emas/马股”等 |
| 语言 | 文本检测 | 高 | 中 | 语言 ≠ 国家；马来语也用于印尼，中文也用于新加坡/中国 |
| 货币/交易所/监管词 | 文本 | 中 | 高 | `MYR`、`RM`、`Bursa Malaysia`、`KLSE`、`SC` |
| 图关系（共同群/转发源） | 已加入群 | 低-中 | 中 | 与已知马来西亚群相邻的群加分 |
| 邀请链接上下文 | 消息、发链接的人 | 低 | 低-中 | 谁在哪个群发、配文语言 |
| `t.me` 页面 | HTTP | 中 | 中 | 标题/成员数；群 about 缺失 |
| geochat `location` | `channelFull` | 极低 | 高 | 只对 geochat 有效 |
| 成员 `lang_code` | TDLib | 用户账号不可用 | 无 | 仅 bot 可见 |
| 成员手机号国家 | TL `user.phone` | 受隐私设置限制；通常仅联系人/自己；无 `country_code` | 不可规模化 |
| 外部目录分类 | 人工/站点 | 低 | 高 | 如“Malaysia”分类，但覆盖有限 |

### 4.2 打分模型（建议）

对每个群计算 `region_confidence`（0–1），并保存证据：

```text
+3  标题/简介出现 Malaysia、MY、Kuala Lumpur、KL、Selangor、Johor、Penang、Sabah、Sarawak
+2  出现 MYR、RM、Bursa Malaysia、KLSE、SC（Securities Commission）
+2  出现马来语/中文马来西亚变体（Pelaburan、Saham、Emas、马股、令吉）
+1  图邻居中已有高置信马来西亚群
+1  邀请来源是马来西亚群/频道
+0.5 t.me 页面语言/描述匹配
-3  出现 Indonesia、Jakarta、IDR、Rupiah、Singapore、India、Nigeria、Global
```

- `>= 0.7`：自动标记 `region_code=MY`；
- `0.4–0.7`：`region_code=MY` + `needs_review=true`；
- `< 0.4`：`region_code=NULL` 或 `region_code=UNKNOWN`。

不要把“语言”直接映射成国家。马来语在印尼也广泛使用；中文在马来西亚、新加坡、中国都在用。必须叠加货币、交易所、城市、图关系等信号。

### 4.3 为什么地区必须是本地过滤

- API 没有 country 参数（3.7）。
- 搜索是全局排序，不是按国家排序；`Forex` 的头部结果通常不是马来西亚。
- 即使 query 里加 “Malaysia”，也会漏掉标题不含该词的本地群；而标题含 “Malaysia” 的也可能是面向全球的频道。
- 地区是“内容/网络属性”，不是 Telegram 实体的标准字段；只能在本地建模、打分、审核、复核。
- 本地过滤还能支持“马来西亚 + 中文 + Forex”这种组合，而 API 只能做单一字符串匹配。

## 5. 开源方案对比表

> 数据来自各仓库 API/源码， stars 与 last commit 为 2026-11-23 查询结果。只列“仓库里确实有源码 + license”的项目；“只有 README/文档/链接列表”的会明确标注。

| 项目 | License | 最近提交 | 技术栈 | 实际做什么 | 群组？ | 地区过滤 | Crawler 是否真的存在 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [tgscan/tgscan](https://github.com/tgscan/tgscan) | GPL-3.0 | 2023-10-31 | Java/Spring + Elasticsearch | 抓 `t.me` 页面，轮换商业代理，索引频道/群/bot，提供 Web 搜索 | 频道 + 群 | 无 | 有：`RoomCrawlJob.java` 解析 `tgme_page_title/description/extra`，`:244/:259` 用 “subscriber”/“member” 判类型 |
| [rooktwo/rectg](https://github.com/rooktwo/rectg) | Apache-2.0 | 2026-11-23 | Python + Astro | 抓 curated 目录/awesome-list，再用 `t.me` 补元数据；中文资源目录 | 主要是频道 | 仅一个“地区社群”分类，2 条资源，不是国家过滤 | 部分：`crawler/telegram.py:117` 只对 `type=="channel"` 抓 `t.me/s`；没有账号搜索 |
| [edogab33/telegram-groups-crawler](https://github.com/edogab33/telegram-groups-crawler) | MIT | 2024-11-06 | Python/Telethon | 从已加入群出发，抓 `t.me` 链接，加入/离开，dump 最近 3000 条消息 | 群 + 频道 | 无 | 有：`scraper.py:226` 搜 `https://t.me/`，`:285` 加入邀请，`:321` 加入频道 |
| [TGrpg/tgbox](https://github.com/TGrpg/tgbox) | **Source-available，非 OSI** | 2026-11-19 | TypeScript/Astro/grammY/Cloudflare D1 | 目录站 + 提交 bot + 管理审核 + cron 存活检查 | 频道/群/bot | 无；只有 `lang` 字段，没有 country | 只有元数据刷新，不是发现爬虫 |
| [houyushan/telegram-groups-search](https://github.com/houyushan/telegram-groups-search) | MIT | 2026-06-18 | 仅文档（Sphinx HTML） | 群组搜索文档/数据集展示 | 群 | 无 | **没有源码** |
| [TelegramDB/TelegramDB](https://github.com/TelegramDB/TelegramDB) | 无 license | 2025-10-02 | 仅 README | 商业 bot/服务 | 不明 | 不明 | **不是开源项目** |
| [AEX-X/telescout](https://github.com/AEX-X/telescout) | MIT | 2026-07-15 | Python/Telethon/Streamlit | `contacts.search` + Web 目录 + 城市查询扩展；只保留公开广播频道 | **仅频道** | 城市关键词扩展，不是过滤 | 有：`telegram_client.py:50` 搜索，`:58` 过滤 `is_public_broadcast_channel` |
| [bigidulka/tg-radar](https://github.com/bigidulka/tg-radar) | MIT | 2026-09-18 | Python/FastAPI/Postgres/Vespa | 默认抓 `t.me/s/<channel>`，可选 Telethon `searchGlobal/contacts.search`；混合检索 | 默认仅频道 | 无 | 有：`crawler.py:38` 抓 `t.me/s`；`telethon_user.py:255-280` 支持群搜索 |
| [thedevs-network/tgdr](https://github.com/thedevs-network/tgdr) | GPL-3.0 | 2024-07-29 | TypeScript/React/Node/Mongo | 目录站 + 提交/审核/评论/点赞 | 频道/bot/超级群 | 无 | **没有 crawler**；`server/models/Entry.ts:6-26` 只有 category/type/username |
| [rignaneseleo/groups-for-nomads](https://github.com/rignaneseleo/groups-for-nomads) | GPL-3.0 | 2026-10-26 | Python + Markdown | 按城市/国家 curated 的群目录 + 站点/bot | 群（含 WhatsApp/Discord） | **有**：城市/国家是主维度，但靠人工提交 | **没有 Telegram crawler** |
| [tgscan/tgrabber](https://github.com/tgscan/tgrabber) | GPL-3.0 | 2023-10-18 | Python/Telethon | 从频道消息里抓 `t.me` 链接，图扩展 | 偏频道 | 无 | 有：`link_crawler.py:113-118` 搜 `https://t.me/` |
| [TGrpg/awesome-telegram](https://github.com/TGrpg/awesome-telegram) | NOASSERTION | 每日更新 | JS |  curated 链接列表 | 频道/群 | 无 | **不是 crawler** |

### 5.1 逐个项目结论

**tgscan/tgscan**：最接近“公开目录”的项目。它不调用 Telegram API 搜索，而是直接抓 `t.me` 页面，用商业代理轮换来规避封 IP；解析标题、描述、订阅/成员数，按 “subscriber”/“member” 判频道/群。([RoomCrawlJob.java:244](https://github.com/tgscan/tgscan/blob/main/api-server/src/main/java/xyz/tgscan/schd/RoomCrawlJob.java#L244), [:259](https://github.com/tgscan/tgscan/blob/main/api-server/src/main/java/xyz/tgscan/schd/RoomCrawlJob.java#L259)) 它没有地区过滤，且 GPL-3.0，代码不能直接抄进闭源产品。

**rooktwo/rectg**：9.4k stars，但本质是“目录的目录”：`crawler/sources.txt` 是一堆 GitHub awesome-list/目录站，抓完后用 `t.me` 补元数据；`crawler/telegram.py:117` 只对频道抓 `t.me/s`，群只抓 profile 页。地区只是分类名 `🌍 地区社群`（`categorize.py:289`），`site/public/llms.txt` 显示该分类只有 2 条频道资源。它不是“按国家搜群”的实现。

**edogab33/telegram-groups-crawler**：最接近“图扩展”的项目。它从账号已加入的群出发，`iter_messages(search="https://t.me/", limit=1000000)` 抓链接，加入新群，再继续抓；用 pickle 保存 `groups/to_be_processed/edges`。([scraper.py:226](https://github.com/edogab33/telegram-groups-crawler/blob/main/scraper.py#L226), [:285](https://github.com/edogab33/telegram-groups-crawler/blob/main/scraper.py#L285), [:321](https://github.com/edogab33/telegram-groups-crawler/blob/main/scraper.py#L321)) README 的 Limitations 写 “for each account ... you can join 25 groups per hour, then Telegram will stop you”。这是观察值，不是官方文档，但很有参考价值。它没有地区过滤。

**AEX-X/telescout**：用 `contacts.search` + Web 目录 + 城市查询扩展，但 `telegram_client.py:58` 只保留 `is_public_broadcast_channel`，**主动丢弃群组**。它的“地区”是 `site:t.me/s "<keyword> <city>"` 这种搜索引擎查询（`web_discovery.py:361-389`），不是 Telegram 地区参数。适合借鉴“查询矩阵”，不适合直接拿来做群组目录。

**bigidulka/tg-radar**：架构最接近本仓库想要的形态：Postgres 状态 + Vespa 混合检索 + FastAPI；默认只抓 `t.me/s` 公开频道，Telethon 可选 `searchGlobal(groups_only=...)` 和 `contacts.search`。([crawler.py:38](https://github.com/bigidulka/tg-radar/blob/master/src/tg_radar/crawler.py#L38), [telethon_user.py:255-280](https://github.com/bigidulka/tg-radar/blob/master/src/tg_radar/telethon_user.py#L255-L280)) 它没有地区过滤，默认索引也是频道。

**TGrpg/tgbox**：**不是开源项目**。LICENSE 明确写 “source-available ... not an open source license ... restricts commercial use, public hosting and competing services”；README 还写 pre-2026-11-19 的版本才是 AGPL-3.0。([LICENSE](https://github.com/TGrpg/tgbox/blob/main/LICENSE)) 它的数据模型只有 `entries.lang`，没有 country/region（`packages/db/migrations/0000_init.sql:33`）。可以借鉴“提交 bot + 审核 + 定时存活检查”，不能复制代码/数据。

**houyushan/telegram-groups-search**：仓库里只有 README 和 Sphinx `docs/` HTML，没有 crawler 源码；MIT 只覆盖文档，数据集来源/授权不清楚。不能当作开源实现引用。

**TelegramDB/TelegramDB**：只有 README.md / README_IT.md，没有 LICENSE、没有源码；是商业服务，不是开源项目。

**thedevs-network/tgdr**：完整的目录站（提交、审核、评论、点赞、排序），但**没有 crawler**；数据靠用户提交。`server/models/Entry.ts:6-26` 只有 `category/description/members/type/username`，没有地区字段。适合借鉴产品/审核流程。

**rignaneseleo/groups-for-nomads**：唯一一个“地区是一等公民”的项目，但它是人工 curated 的 Markdown 数据集（按城市/国家），不是 Telegram 爬虫。适合借鉴“地区分类 + 提交”的产品形态。

**tgscan/tgrabber**：从频道消息里抓 `t.me` 链接做图扩展，`link_crawler.py:113-118`；适合借鉴“从消息里提取链接”的 regex/实体处理。

## 6. 推荐架构（分阶段）

### 6.1 总览

```text
                    ┌─────────────────────┐
                    │  Query Matrix        │
                    │  (EN/MS/ZH + geo)    │
                    └──────────┬──────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
┌───────▼────────┐   ┌─────────▼────────┐   ┌─────────▼────────┐
│ contacts.search│   │ messages.search  │   │ t.me / invite    │
│ (seed, 1 page) │   │ (groups_only)    │   │ enrichment       │
└───────┬────────┘   └─────────┬────────┘   └─────────┬────────┘
        │                      │                      │
        └──────────────────────┼──────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Candidate queue     │
                    │  dedupe by chat_id   │
                    └──────────┬──────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
┌───────▼────────┐   ┌─────────▼────────┐   ┌─────────▼────────┐
│ graph crawl    │   │ verify/refresh   │   │ region classifier│
│ (joined groups)│   │ (GetFullChannel) │   │ (rules + review) │
└───────┬────────┘   └─────────┬────────┘   └─────────┬────────┘
        │                      │                      │
        └──────────────────────┼──────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  group_directory     │
                    │  Postgres FTS/trgm   │
                    │  (optional Meili)    │
                    └──────────────────────┘
```

核心原则：

1. **搜索只负责“种子”，不负责“全量”。** `contacts.search` 单页、无 offset，不能当目录用。
2. **t.me 和邀请链接负责“补全”，不负责“发现”。** 它们需要先有 username/invite hash。
3. **图扩展负责“扩量”，但只从已加入群出发。** 代价是入群配额和账号风险。
4. **地区在本地打分，不在 API 查询里。**
5. **所有候选都保留 evidence**，便于复核和解释“为什么它被认为是马来西亚”。

### 6.2 数据模型

建议新增“全局目录”表，保留现有 `group_profiles` 作为“账号视角的快照”。不要让全局搜索依赖 `group_profiles` 的 per-account 唯一键。

```sql
-- 规范化后的全局目录
CREATE TABLE group_directory (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tg_chat_id          bigint UNIQUE,              -- 稳定主键；可能为空（仅 invite）
    username            citext,                     -- 规范化小写；可空
    title               text NOT NULL,
    about               text,
    kind                text NOT NULL,              -- group / supergroup / channel / bot
    is_public           boolean NOT NULL DEFAULT false,
    invite_hash         text,                       -- 仅私有邀请；加密/脱敏存储
    member_count        integer,
    language_code       text,                       -- 文本检测，不是成员 lang_code
    region_code         char(2),                    -- ISO 3166-1 alpha-2; MY / ID / SG / NULL
    region_confidence   numeric(3,2) NOT NULL DEFAULT 0,
    region_evidence     jsonb NOT NULL DEFAULT '{}',-- {"matched":["malaysia","bursa"],"source":"title"}
    status              text NOT NULL DEFAULT 'active', -- active/stale/dead/private/renamed
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    tme_checked_at      timestamptz,
    full_checked_at     timestamptz,
    fts                 tsvector GENERATED ALWAYS AS (
        to_tsvector('simple',
            coalesce(title,'') || ' ' || coalesce(about,'') || ' ' || coalesce(username,''))
    ) STORED
);

CREATE UNIQUE INDEX group_directory_username_uq
    ON group_directory (username) WHERE username IS NOT NULL;
CREATE INDEX group_directory_fts_idx ON group_directory USING GIN (fts);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX group_directory_title_trgm_idx
    ON group_directory USING GIN (title gin_trgm_ops);

-- 证据：哪个账号、哪个 query、哪个来源发现/确认了它
CREATE TABLE group_directory_evidence (
    id              bigserial PRIMARY KEY,
    group_id        uuid NOT NULL REFERENCES group_directory(id) ON DELETE CASCADE,
    source          text NOT NULL,   -- contacts_search / search_global / tme / invite / graph / submission / directory
    account_id      uuid REFERENCES accounts(id),
    query           text,
    url             text,
    excerpt         text,
    weight          numeric(3,2) NOT NULL DEFAULT 1,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- 查询矩阵与执行记录，避免重复烧账号
CREATE TABLE group_search_query (
    id              bigserial PRIMARY KEY,
    keyword         text NOT NULL,
    region_code     char(2),
    language        text,           -- en / ms / zh
    tier            smallint NOT NULL, -- 1 exact geo, 2 term+geo, 3 term+city, 4 term only
    enabled         boolean NOT NULL DEFAULT true,
    last_run_at     timestamptz,
    last_result_count integer,
    UNIQUE (keyword, region_code, language)
);

-- 图扩展 frontier
CREATE TABLE group_crawl_frontier (
    id              bigserial PRIMARY KEY,
    seed_group_id   uuid REFERENCES group_directory(id),
    seed_username   text,
    depth           smallint NOT NULL DEFAULT 1,
    status          text NOT NULL DEFAULT 'pending', -- pending/running/done/failed
    next_run_at     timestamptz,
    attempts        smallint NOT NULL DEFAULT 0
);
```

迁移策略：

- 先建 `group_directory`，从现有 `group_profiles` 回填：按 `tg_chat_id` 去重，取最新一条做 title/about/member_count；
- `group_profiles` 增加 `directory_id` 外键，后续写入时双写；
- API 搜索切到 `group_directory`，保留 `group_profiles` 作为账号详情页数据源；
- `group_members` 已经是全局 `(tg_chat_id, tg_user_id)` 唯一，不需要改。

### 6.3 Worker 设计

| Worker | 输入 | 动作 | 账号 | 频率/限流 |
| --- | --- | --- | --- | --- |
| `search_worker` | `group_search_query` | `contacts.SearchRequest(q, limit=50)`；只取 `res.chats`；写 evidence | 用户账号，只读 | 每账号并发 1；每 query 2–5s jitter；日预算 |
| `message_search_worker` | 关键词 | `messages.searchGlobal(groups_only=True, ...)` 翻页；从消息 peer 反查群 | 用户账号 | 低频；只做补充 |
| `tme_worker` | username | `GET https://t.me/<username>`；解析 OG/tgme；`t.me/s` 仅频道 | 无账号（httpx） | 1–2 rps；缓存 7 天 |
| `graph_worker` | 已加入群 | `iter_messages(search="t.me/", limit=...)`；regex/entity 提取；入 frontier | 已加入群的账号 | 每群每天一次；不要并发 |
| `verify_worker` | 候选 | `ResolveUsername` / `GetFullChannel` / `CheckChatInvite`；更新 status/member_count/about | 用户账号 | 低峰；按需 |
| `region_worker` | 文本/证据 | 规则打分；0.4–0.7 进人工队列 | 无 | 事件驱动 |
| `index_worker` | 变更 | 更新 `fts`；可选同步 Meilisearch | 无 | 事件驱动 |
| `submission_worker` | bot/web 提交 | 解析链接、去重、验证、进审核 | 用户账号验证 | 每用户每日 1 条 |

实现建议：

- 复用现有 `TaskType`/队列，不要新起一套调度；新增 `TaskType.discover_groups` 或在现有 `search_groups` 上扩展 `region`/`tier` 字段。
- `search_worker` 与 `join_worker` 分开账号：搜索账号不加入任何群；加入账号只做图扩展，且用后即弃。
- 所有外部调用写 `group_directory_evidence`，便于回溯“这个群是怎么来的”。
- 失败重试用指数退避；`FloodWait` 不重试，直接睡。

### 6.4 查询矩阵（马来西亚）

不要把 “Forex Malaysia” 当成唯一 query。按 tier 组织：

| Tier | 形式 | 例子 | 频率 | 目的 |
| --- | --- | --- | --- | --- |
| 1 | 精确国家短语 | `Forex Malaysia`, `Trading Emas`, `Pelaburan Emas`, `马来西亚 外汇` | 每日 | 高精度种子 |
| 2 | 词 + 国家/州 | `Forex KL`, `Gold Johor`, `Saham Penang`, `外汇 吉隆坡` | 每周 2–3 次 | 覆盖本地群 |
| 3 | 词 + 城市 | `Forex Kota Kinabalu`, `Emas Kuching`, `股票 新山` | 每周 | 长尾 |
| 4 | 纯词 | `Forex`, `Trading`, `Gold` | 每周/低优先 | 只用于发现新词，不直接入库为 MY |

**主题矩阵：**

| 主题 | English | Bahasa Melayu | 中文 | 备注 |
| --- | --- | --- | --- | --- |
| Forex | `Forex Malaysia`, `Malaysia Forex`, `Forex KL`, `Forex Johor`, `Forex Penang` | `Forex Malaysia`, `Belajar Forex`, `Signal Forex`, `Komuniti Forex` | `马来西亚 外汇`, `大马 外汇`, `吉隆坡 外汇`, `外汇 交流` | 避免单用 `Forex` |
| Trading | `Trading Malaysia`, `Day Trading Malaysia`, `Gold Trading Malaysia` | `Trading Malaysia`, `Trading Emas`, `Trading Saham` | `马来西亚 交易`, `大马 交易`, `黄金 交易` | `Trading` 单用太宽 |
| Gold | `Gold Malaysia`, `XAUUSD Malaysia`, `Gold Investment Malaysia` | `Emas Malaysia`, `Pelaburan Emas`, `Dinar Emas`, `Emas 999` | `马来西亚 黄金`, `大马 黄金`, `黄金 投资`, `炒金` | `Gold` 单用会命中 Gold Coast |
| Stocks | `Bursa Malaysia`, `KLSE`, `Malaysia Stocks` | `Saham Malaysia`, `Bursa Malaysia`, `Pelaburan Saham` | `马股`, `马来西亚 股票`, `吉隆坡 股票` | `Bursa/KLSE` 是强信号 |
| Investment | `Investment Malaysia`, `Wealth Malaysia` | `Pelaburan Malaysia`, `Kewangan`, `Pelaburan` | `马来西亚 投资`, `理财 马来西亚` | `Pelaburan` 也用于印尼 |
| Signals/community | `Forex Signal MY`, `Trading Community Malaysia` | `Signal Forex`, `Komuniti Trading` | `外汇 交流`, `黄金 交流`, `交易 群` | 信号群多为小群 |
| Crypto（可选） | `Crypto Malaysia`, `Bitcoin Malaysia` | `Kripto Malaysia` | `马来西亚 加密货币` | 与 Forex 人群重叠 |

**地理修饰词：**

`Malaysia`, `MY`, `KL`, `Kuala Lumpur`, `Selangor`, `Johor`, `JB`, `Penang`, `Pulau Pinang`, `Sabah`, `Sarawak`, `Melaka`, `Ipoh`, `Kuching`, `Kota Kinabalu`, `Putrajaya`.

**负向词（用于降权，不是 API 过滤）：**

`Indonesia`, `Jakarta`, `IDR`, `Rupiah`, `Singapore`, `SG`, `India`, `Nigeria`, `Global`, `Worldwide`.

**查询构造规则：**

- Telegram 没有布尔语法；用短语字符串，不要写 `Forex AND Malaysia`。
- 同一主题至少覆盖 EN/MS/ZH 三种写法；马来西亚中文群常用“马股/令吉/外汇/黄金”，不要只用大陆用语。
- 先用 Tier 1 建立高置信种子，再用 Tier 2/3 扩量；Tier 4 只用于发现新词，不直接把结果标成 MY。
- 每个 query 记录 `last_result_count`；连续为 0 的 query 降频，避免烧账号。
- 去重键：优先 `tg_chat_id`；没有则 `username` 小写；邀请链接用 hash。

### 6.5 多账号 / FloodWait / 入群配额

**账号角色分离：**

| 角色 | 用途 | 是否入群 | 备注 |
| --- | --- | --- | --- |
| `search` | contacts.search / searchGlobal | 否 | 只读，最安全 |
| `enrich` | 无账号，t.me/网页 | 否 | 不需要 Telegram session |
| `graph` | 读已加入群历史、抓链接 | 是 | 专用小号，控制数量 |
| `verify` | ResolveUsername/GetFullChannel/CheckChatInvite | 否 | 低频 |
| `submission` | 处理用户提交 | 否 | bot + 人工 |

**FloodWait：**

- `FLOOD_WAIT_%d` 是秒数；收到后 sleep 精确秒数 + 随机 10–30%，不要立刻重试。([api/errors](https://core.telegram.org/api/errors))
- 连续两次 `FLOOD_WAIT`：该账号冷却 6–24 小时；`PeerFloodError`：冷却 24 小时并降权；`UserDeactivatedBanError`：禁用账号并告警。
- 仓库已有 `backend/app/services/throttle.py:118` 使用 per-account `official_limits`；新增 `channels_limit_default/premium` 读取，不要硬编码 500/1000。`backend/app/services/official.py:83` 已把 `channels_` 加入白名单，`help.GetAppConfig` 返回的 `channels_limit_default` / `channels_limit_premium` 会被存下来。

**入群配额：**

- 官方客户端源码：默认 500，Premium 1000（`channels_limit_default` / `channels_limit_premium`，可被服务端 app-config 覆盖）。([data_premium_limits.cpp:19-23](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/data/data_premium_limits.cpp#L19-L23))
- `CHANNELS_TOO_MUCH` 是达到上限时的错误；TDLib 注释明确说可以用 Premium 提高上限。([td_api.tl L13144](https://github.com/tdlib/td/blob/master/td/generate/scheme/td_api.tl#L13144))
- edogab33 README 观察值：每账号每小时约 25 个群，超过会被 Telegram 阻止。([README](https://github.com/edogab33/telegram-groups-crawler)) 这不是官方数字，标为 observed。
- 只对高价值群入群；入群后不要立刻退出，至少保留数小时到一天；退出也限速。不要把主账号用于图扩展。

### 6.6 本地搜索索引选型

| 方案 | 优点 | 缺点 | 适用阶段 |
| --- | --- | --- | --- |
| Postgres `tsvector` + GIN | 事务一致、无新服务、`ts_rank` 可用 | 默认分词对中文/马来语不友好；`simple` 只是空格切分 | Phase 1 |
| Postgres `pg_trgm` + GIN | 支持子串/模糊，CJK 3-gram 可用；`similarity()` 排序 | 索引较大；2 字中文查询弱；无语义 | Phase 1 |
| `zhparser` | 中文分词更好 | 需要自定义 Postgres 镜像/扩展；运维成本 | 可选 |
| Meilisearch | 拼写容错、CJK、facets、即时搜索 | 多一个服务；需要同步管道 | Phase 2（>10 万条或 CJK 相关性不足） |
| Vespa | 大规模混合检索 | 重；运维复杂 | 不建议当前阶段 |

建议 Phase 1 用 Postgres：

```sql
-- 英文/马来语：simple + trigram 兜底
SELECT id, title, region_code, region_confidence
FROM group_directory
WHERE fts @@ plainto_tsquery('simple', $1)
   OR title % $1
ORDER BY
  (region_code = 'MY') DESC,
  ts_rank(fts, plainto_tsquery('simple', $1)) DESC,
  similarity(title, $1) DESC,
  member_count DESC NULLS LAST
LIMIT 50;
```

中文查询用 `pg_trgm` 的 `%`/`similarity` 兜底；如果 2 字查询效果差，再上 Meilisearch。不要一开始就引入 Meilisearch，除非已有 10 万+ 群或明确需要拼写容错。

### 6.7 验证、刷新、提交

**验证：**

- 公开 username：`contacts.resolveUsername` → [`channels.getFullChannel`](https://core.telegram.org/method/channels.getFullChannel)（或 [`messages.getFullChat`](https://core.telegram.org/method/messages.getFullChat)）拿 about/member_count/location；
- 私有 invite：`messages.checkChatInvite(hash)` 拿 title/about/participants_count；`chatInviteAlready` 表示已加入；
- 公开页面：`t.me/<username>` 拿 title/member_count；频道再抓 `t.me/s` 拿最近帖子；
- 状态机：`active → stale（30 天未确认）→ dead（404/CHANNEL_PRIVATE/INVITE_HASH_EXPIRED）`；改名用 `tg_chat_id` 保持稳定，username 变更记录历史。

**刷新：**

- `t.me` 每 7 天；`GetFullChannel` 每 30 天；高价值群每 7 天；
- member_count 变化、about 变化、username 变化都写 evidence；
- 死链/私密化自动降权，不立即删除，保留审计。

**提交：**

- Web 表单 + Telegram bot；只接受 `t.me/<username>`、`t.me/+hash`、`t.me/joinchat/hash`；
- 解析后先查重（username/chat_id/invite_hash），再进 `submission` 表；
- 用户账号做 `CheckChatInvite`/`ResolveUsername` 验证；bot 只做转发/通知；
- 每用户每日 1 条，管理员审核；提交者 ID 脱敏存储；
- 审核界面显示 evidence、region_confidence、成员数、最近活跃，避免盲批。

### 6.8 分阶段落地

| 阶段 | 时间 | 交付 | 退出标准 |
| --- | --- | --- | --- |
| Phase 0 | 1–2 天 | 停止把 `contacts.search` 宣传成目录；加 `region_code/region_confidence/region_evidence` 字段；把查询矩阵写入配置；加上“本次返回数/去重数/地区命中数”指标 | 能解释每次搜索为什么少；UI 有地区筛选 |
| Phase 1 | 1 周 | `group_directory` 表 + 回填；`search_worker` 用 Tier 1/2 矩阵；`tme_worker` 补全；Postgres FTS/pg_trgm；API 切全局目录 | 马来西亚 Forex/Trading/Gold 各有可解释的种子；搜索延迟 < 200ms |
| Phase 2 | 2–3 周 | `graph_worker` 从已加入群扩展；多账号调度 + FloodWait/配额；`verify_worker` 状态机；提交 bot + 审核 | 目录持续增长；账号无连续封禁；死链可自动降权 |
| Phase 3 | 持续 | 定时刷新、质量评分、人工复核队列、可选 Meilisearch、目录页/SEO（如需要） | 目录新鲜度 < 30 天；误标率可测量 |

## 7. 风险与合规

| 风险 | 事实/依据 | 缓解 |
| --- | --- | --- |
| 私有群不可发现 | 私有群没有公开 username；只能靠 invite hash 或成员邀请；`checkChatInvite` 需要有效 hash。官方邀请文档明确基本群必须先迁移为超级群才有 username。([api/invites](https://core.telegram.org/api/invites)) | 产品上明确“只覆盖公开群/可预览邀请”；不要承诺全量 |
| 入群上限 | 官方客户端默认 500，Premium 1000；`CHANNELS_TOO_MUCH`。([data_premium_limits.cpp:19-23](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/data/data_premium_limits.cpp#L19-L23), [td_api.tl L13144](https://github.com/tdlib/td/blob/master/td/generate/scheme/td_api.tl#L13144)) | 专用 graph 账号；只加高价值群；入群/退群限速；监控配额 |
| 每小时入群观察值 | edogab33 README：每账号约 25 群/小时会被阻止。([README](https://github.com/edogab33/telegram-groups-crawler)) | 按 20/小时保守限速；失败即停 |
| FloodWait | `FLOOD_WAIT_%d` 秒；官方 errors。([api/errors](https://core.telegram.org/api/errors)) | 精确 sleep + jitter；连续触发冷却；仓库 `throttle.py` 已有基础 |
| 账号封禁 | API 使用条款： flooding/spamming/faking 计数会导致永久封禁；非官方 API 登录账号会被“under observation”。([api/obtaining_api_id](https://core.telegram.org/api/obtaining_api_id)) | 账号分层；新号预热；不在主账号上跑 crawler；告警 |
| 抓取 ToS | `t.me` 公开页面可访问，但没有官方“允许批量抓取”的承诺；API ToS 1.5 限制将 Telegram 数据用于 AI 训练/聚合。([api/terms](https://core.telegram.org/api/terms)) | 低频、缓存、遵守 robots/ToS；不训练模型；必要时申请许可 |
| GPL/AGPL | tgscan、tgrabber、tdesktop、tgdr、groups-for-nomads 是 GPL-3.0；抄代码会触发 GPL。tgbox 是 source-available，禁止商用/公开托管/竞品目录。([tgscan](https://github.com/tgscan/tgscan), [tgbox LICENSE](https://github.com/TGrpg/tgbox/blob/main/LICENSE)) | 只借鉴思路/协议，不复制代码；需要复用时隔离进程并遵守许可证；法务复核 |
| 个人数据/隐私 | 马来西亚 PDPA 2010 对个人数据处理有要求；金融推广还涉及 Securities Commission 规则。([PDPA](https://www.pdp.gov.my/), [SC](https://www.sc.com.my/)) | 只存公开群元数据；不抓个人手机号；成员数据最小化；提供删除/更正渠道；非法律意见 |
| 数据质量 | 群会改名、死链、私密化、诈骗群；`t.me` 页面可能变化。 | 状态机 + 定期复核 + 人工审核 + 证据链；不要把“搜到”等同于“可信” |

## 8. 不确定性与待验证

以下结论没有从官方文档得到硬保证，落地前应做小规模验证：

1. `contacts.search` 的服务端最大 `limit`、排序权重、不同账号/DC 的差异：**unverified**。
2. `contacts.search` 到底只匹配 username，还是也匹配 title：官方 method 页说 username substring，TDLib 说 title+username；两者不一致，**以实测为准**。
3. `messages.searchGlobal(groups_only=True)` 是否覆盖“所有公开群”、是否覆盖未加入的群：官方没有明确承诺，**unverified**。
4. 每账号 25 群/小时的入群上限：来自 edogab33 README 的观察值，不是官方数字，**observed only**。
5. `contacts.getLocated` 在当前客户端/当前账号类型下是否仍可用：文档存在，但产品可用性未验证，**unverified**。
6. `t.me/s` 只支持广播频道、群组 about 不暴露：本次实测结论，可能随 Telegram 页面改版变化，**empirical**。
7. Bot API `getChat` 对非成员公开群的字段覆盖：未逐项验证，**unverified**。
8. TelegramDB 的数据来源、覆盖范围、授权：仓库没有源码/许可证，**unknown**。
9. `channels.getFullChannel` 对未加入的公开超级群是否总是可用：文档说 users/bots 可用，但没有承诺所有公开群；**以实测为准**。

## 9. 参考来源

### 9.1 官方 Telegram 文档

- [method/contacts.search](https://core.telegram.org/method/contacts.search)
- [method/messages.searchGlobal](https://core.telegram.org/method/messages.searchGlobal)
- [method/channels.searchPosts](https://core.telegram.org/method/channels.searchPosts)
- [method/contacts.getSponsoredPeers](https://core.telegram.org/method/contacts.getSponsoredPeers)
- [method/messages.checkChatInvite](https://core.telegram.org/method/messages.checkChatInvite)
- [method/channels.getFullChannel](https://core.telegram.org/method/channels.getFullChannel)
- [method/contacts.resolveUsername](https://core.telegram.org/method/contacts.resolveUsername)
- [api/search](https://core.telegram.org/api/search)
- [api/nearby](https://core.telegram.org/api/nearby)
- [api/invites](https://core.telegram.org/api/invites)
- [api/channel](https://core.telegram.org/api/channel)
- [api/errors](https://core.telegram.org/api/errors)
- [api/terms](https://core.telegram.org/api/terms)
- [api/obtaining_api_id](https://core.telegram.org/api/obtaining_api_id)
- [Telegram FAQ](https://telegram.org/faq)
- [constructor/user](https://core.telegram.org/constructor/user)
- [constructor/channel](https://core.telegram.org/constructor/channel)
- [constructor/channelFull](https://core.telegram.org/constructor/channelFull)
- [Bot API](https://core.telegram.org/bots/api)
- [api/limits](https://core.telegram.org/api/limits)（调研时 404；没有官方静态限制页）

### 9.2 TL schema / TDLib / 官方客户端源码

- [telegram_api.tl L117（user）](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L117)
- [telegram_api.tl L132（channel）](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L132)
- [telegram_api.tl L138（channelFull）](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L138)
- [telegram_api.tl L2645（contacts.search）](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L2645)
- [telegram_api.tl L2662（getSponsoredPeers）](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L2662)
- [telegram_api.tl L2705（checkChatInvite）](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L2705)
- [telegram_api.tl L2714（searchGlobal）](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L2714)
- [telegram_api.tl L2991（getFullChannel）](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L2991)
- [telegram_api.tl L3036（searchPosts）](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L3036)
- [telegram_api.tl L1373（channelLocation）](https://github.com/tdlib/td/blob/master/td/generate/scheme/telegram_api.tl#L1373)
- [td_api.tl L13055-L13067（searchPublicChats / searchChatsOnServer）](https://github.com/tdlib/td/blob/master/td/generate/scheme/td_api.tl#L13055-L13067)
- [td_api.tl L13144（CHANNELS_TOO_MUCH）](https://github.com/tdlib/td/blob/master/td/generate/scheme/td_api.tl#L13144)
- [td_api.tl L3161-L3163（user.language_code）](https://github.com/tdlib/td/blob/master/td/generate/scheme/td_api.tl#L3161-L3163)
- [td_api.tl L4428-L4430（accountInfo.phone_number_country_code）](https://github.com/tdlib/td/blob/master/td/generate/scheme/td_api.tl#L4428-L4430)
- [Telegram Desktop data_premium_limits.cpp L19-L23](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/data/data_premium_limits.cpp#L19-L23)

### 9.3 开源项目

- [tgscan/tgscan](https://github.com/tgscan/tgscan)（GPL-3.0）；[RoomCrawlJob.java:244](https://github.com/tgscan/tgscan/blob/main/api-server/src/main/java/xyz/tgscan/schd/RoomCrawlJob.java#L244)、[:259](https://github.com/tgscan/tgscan/blob/main/api-server/src/main/java/xyz/tgscan/schd/RoomCrawlJob.java#L259)
- [rooktwo/rectg](https://github.com/rooktwo/rectg)（Apache-2.0）；[telegram.py:117](https://github.com/rooktwo/rectg/blob/main/crawler/telegram.py#L117)、[categorize.py:289](https://github.com/rooktwo/rectg/blob/main/crawler/categorize.py#L289)、[sources.txt](https://github.com/rooktwo/rectg/blob/main/crawler/sources.txt)
- [edogab33/telegram-groups-crawler](https://github.com/edogab33/telegram-groups-crawler)（MIT）；[scraper.py:226](https://github.com/edogab33/telegram-groups-crawler/blob/main/scraper.py#L226)、[:285](https://github.com/edogab33/telegram-groups-crawler/blob/main/scraper.py#L285)、[:321](https://github.com/edogab33/telegram-groups-crawler/blob/main/scraper.py#L321)
- [TGrpg/tgbox](https://github.com/TGrpg/tgbox)（source-available，非 OSI）；[LICENSE](https://github.com/TGrpg/tgbox/blob/main/LICENSE)、[0000_init.sql:33](https://github.com/TGrpg/tgbox/blob/main/packages/db/migrations/0000_init.sql#L33)
- [houyushan/telegram-groups-search](https://github.com/houyushan/telegram-groups-search)（MIT，仅文档）
- [TelegramDB/TelegramDB](https://github.com/TelegramDB/TelegramDB)（无 license，非开源）
- [AEX-X/telescout](https://github.com/AEX-X/telescout)（MIT）；[telegram_client.py:50](https://github.com/AEX-X/telescout/blob/main/telescout/telegram_client.py#L50)、[web_discovery.py:361-389](https://github.com/AEX-X/telescout/blob/main/telescout/web_discovery.py#L361-L389)
- [bigidulka/tg-radar](https://github.com/bigidulka/tg-radar)（MIT）；[crawler.py:38](https://github.com/bigidulka/tg-radar/blob/master/src/tg_radar/crawler.py#L38)、[config.py:30](https://github.com/bigidulka/tg-radar/blob/master/src/tg_radar/config.py#L30)、[telethon_user.py:255-280](https://github.com/bigidulka/tg-radar/blob/master/src/tg_radar/telethon_user.py#L255-L280)
- [thedevs-network/tgdr](https://github.com/thedevs-network/tgdr)（GPL-3.0）；[Entry.ts:6-26](https://github.com/thedevs-network/tgdr/blob/develop/server/models/Entry.ts#L6-L26)
- [rignaneseleo/groups-for-nomads](https://github.com/rignaneseleo/groups-for-nomads)（GPL-3.0）
- [tgscan/tgrabber](https://github.com/tgscan/tgrabber)（GPL-3.0）；[link_crawler.py:113-118](https://github.com/tgscan/tgrabber/blob/main/tgrabber/crawler/link_crawler.py#L113-L118)
- [TGrpg/awesome-telegram](https://github.com/TGrpg/awesome-telegram)（NOASSERTION，链接列表）

### 9.4 本仓库代码

- `backend/app/worker/group_intel.py:343` `_search_groups`；`:366` `contacts.SearchRequest`
- `backend/app/schemas/group_intel.py:217` `SearchGroupsRequest`
- `backend/app/models/group_intel.py:58` `GroupProfile`；`:90` 唯一键 `(account_id, tg_chat_id)`
- `backend/app/api/routers/group_intel.py:108` `search-groups` 端点；`:545` `ilike` 搜索
- `backend/app/services/official.py:70-83` `LIMIT_KEY_PREFIXES`（含 `channels_`）
- `backend/app/services/throttle.py:118` `official_limits` 使用
- `backend/alembic/versions/f7b3d6e21c48_official_limits.py:1-20` `official_limits` 列
- `docs/COMPETITOR_ANALYSIS.md:99` 端到端仅找到 3 个群的记录

### 9.5 实测记录

- 2026-11-23：`curl -L` 访问 `https://t.me/durov`、`https://t.me/s/durov`、`https://t.me/tdlibchat`、`https://t.me/s/tdlibchat`；结果见 3.6。该实测只代表当时页面行为，不是官方契约。
