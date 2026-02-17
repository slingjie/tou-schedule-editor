# Cloudflare Access (Zero Trust) 用户认证配置指南（中文界面版）

本文档指导您为 **TOU Schedule Editor** 应用启用 Cloudflare Access 认证保护。
启用后，用户必须先通过邮箱验证才能访问应用，**无需修改任何代码**。

---
> [!TIP]
> **推荐方法**：直接在 Cloudflare Pages 设置中开启认证（见下文“快速配置”章节），比手动去 Zero Trust 面板配置更简单，不易出错。

## 前置条件

- 拥有 Cloudflare 账号
- 应用已部署到 Cloudflare Pages（例如 `https://tou-schedule-editor.pages.dev`）
- 免费版支持最多 **50 个用户**

- 免费版支持最多 **50 个用户**

---

## 快速配置（推荐）

这是最简单的方法，直接在 Pages 项目中开启，自动生成正确的配置。

1. **进入 Pages 项目设置**
   - 登录 Cloudflare Dashboard -> **Workers & Pages**
   - 点击您的项目 `tou-schedule-editor`
   - 点击 **Settings (设置)** 标签页

2. **开启访问策略**
   - 找到 **Access Policy (访问策略)** 卡片（通常在 Public Access 或 General 区域）
   - 点击 **Enable Access Policy (启用访问策略)**

3. **配置允许的访问者**
   - 在弹出的窗口中，选择 **Restrict access to... (限制访问...)**
   - **Selector (选择器)**: 选 `Emails`
   - **Value (值)**: 输入您的邮箱，如 `yourname@example.com`
   - 点击 **Save (保存)**

**完成！** 这种方法会自动处理域名配置，避免手动填错。

---

## 手动配置步骤（备选）

如果您需要更高级的配置，或者想了解底层原理，可以手动去 Zero Trust 面板配置：

### 1. 进入“零信任” (Zero Trust) 面板

1. 登录 [Cloudflare 控制台 (Dashboard)](https://dash.cloudflare.com)
2. 在左侧菜单栏中找到并点击 **Zero Trust (零信任)** 
   - *提示：如果找不到，可能被折叠在“更多产品”里，或者直接访问 `one.dash.cloudflare.com`*
3. **首次使用提示**：如果您是第一次点击，系统会要求您：
   - 选择一个团队名称（Team name），例如输入您的名字拼音或公司名，点击 **Next (下一步)**
   - 选择 **Free (免费)** 计划，点击 **Proceed to payment (继续支付)** 
   - *注意：即使是免费计划，某些账号可能仍需绑定支付方式（信用卡/PayPal），但不会扣款。*

### 2. 添加应用程序 (Add Application)

1. 进入 Zero Trust 面板后，点击左侧菜单的 **Access (访问)** -> **Applications (应用程序)**
2. 点击页面中间或右上角的 **Add an application (添加应用程序)** 按钮
3. 选择 **Self-hosted (自托管)** 
4. **配置应用信息**：

| 字段 (英文) | 字段 (中文含义) | 填写内容 |
|---|---|---|
| **Application name** | 应用程序名称 | `TOU Schedule Editor` |
| **Session Duration** | 会话持续时间 | 建议选 `24 hours` (24小时) |
| **Application domain** | 应用程序域名 | 在 `Subdomain` 框填: `tou-schedule-editor` <br> 在 `Domain` 下拉框选: `pages.dev` <br> **重要提示**：`Subdomain` 框**只需填前缀**，不要重复填完整域名！如果已经自动填好，**请保持默认**，不要额外添加不必要的子域前缀（如 `123`）。 |

5. 向下滚动，点击 **Next (下一步)**

### 3. 配置访问策略 (Add Policy)

这一步决定**谁可以访问**您的应用：

1. **Policy name (策略名称)**: 输入 `允许团队成员`
2. **Action (操作)**: 保持默认的 **Allow (允许)**
3. **Configure rules (配置规则)** - 在 `Include (包含)` 部分，点击下拉框选择规则类型：

**场景 A：指定特定邮箱（推荐）**
- **Selector (选择器)**: 选择 **Emails (电子邮件)**
- **Value (值)**: 输入您允许访问的邮箱地址，例如 `user1@example.com`
- *如果要加多人，再添加一行或用逗号分隔*

**场景 B：允许整个公司邮箱**
- **Selector (选择器)**: 选择 **Emails ending in (电子邮件后缀)**
- **Value (值)**: 输入 `@yourcompany.com`

**场景 C：允许任何人（不推荐，仅测试用）**
- **Selector (选择器)**: 选择 **Everyone (所有人)**

4. 点击 **Next (下一步)** -> 最后点击 **Add application (添加应用程序)**

### 4. 验证与完成

现在配置已生效！

**如何验证：**
1. 开启一个浏览器的**无痕模式 (Incognito Window)**
2. 访问您的应用网址（例如 `https://tou-schedule-editor.pages.dev`）
3. 您应该会看到一个 **Cloudflare Access 登录页**
4. 输入您在第3步中授权的邮箱
5. 去邮箱查收 **验证码 (Code)**
6. 输入验证码，即可成功进入应用

---

## 进阶设置（可选）

### 添加 GitHub / Google 登录
如果不喜欢输验证码，可以开启第三方登录：

1. 在 Zero Trust 面板左侧，点击 **Settings (设置)** -> **Authentication (认证)**
2. 在 **Login methods (登录方式)** 区域，点击 **Add new (添加新方式)**
3. 选择 **GitHub** 或 **Google**
4. 按照屏幕提示，去 GitHub/Google 配置 OAuth App 并填入 Client ID 和 Secret
5. 保存后，用户登录页就会出现 "Sign in with GitHub" 按钮

---

## 常见问题

**Q: 为什么我访问不需要验证？**
A: 可能是因为您之前登录过，且 Session 还没过期（默认24小时）。请尝试用无痕模式访问。

**Q: 本地开发 `localhost:5173` 会受影响吗？**
A: 不会。Cloudflare Access 只保护部署在公网的 `pages.dev` 域名。本地开发直接访问，不经过 Cloudflare。

**Q: 免费额度是多少？**
A: 免费版支持 **50 个用户**。如果超过，需要升级到 Standard 计划。
