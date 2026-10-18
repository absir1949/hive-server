# 122 开发与检查接入

## 范围

Linux 开发、编译和隔离检查目标为 Ser5（122），runner labels 为 `self-hosted,Linux,X64,with-agent`。每个任务使用独立分支与独立工作树；不借用生产 checkout、`.env`、账号、Cookie 或数据。这个 PR 只接入检查，不宣称需求自动领取、修复调度器或上线部署已接通。

## 检查入口

依赖版本：Node 22.22.2；npm ci 使用已提交 package-lock，禁 lifecycle scripts。

```sh
npm ci --ignore-scripts
bash scripts/ci/checks.sh
```

覆盖：现有 node:test 全量单测（临时文件、fake Docker/browser、进程内 HTTP）；不启动业务 server 或真实 Chrome。

入口拒绝带本地环境文件的 checkout。安装和检查需要使用全新 Git 工作树，不能复制生产环境。PR 仅同仓分支运行，fork PR 不把代码交给常驻 self-hosted runner。检查不会读取评审模型凭证；不会调用 Docker、迁移、生产数据库、外部业务接口或部署命令。GitHub 的同仓写权限仍是执行信任边界，不等于容器沙箱。

## 交付与恢复

需求由 Issue 明确目标/验收，开发提交 PR，`Linux checks` 绑定提交 SHA；评审与修复仍由现有协调会话承接，不另建消费者。代码评审与运行检查分别记录；同一 head 的静态批准不能代替运行结果。评审服务由系统侧统一维护，本 PR 不修改 `agent-review.yml`。

测试失败保持红灯，不用跳过/吞退出码制造 PASS。真实设备、真实账号、跨服务联调未在这个检查里执行，不因此变成已验收。任务完成前列出 head/base、命令、退出码和未覆盖项。合并与生产部署由人决定。

不停止业务容器、不删除缓存/租约/别人的工作区。回退只 revert 本 PR 的 Git 文件。
