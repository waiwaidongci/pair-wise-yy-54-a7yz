# 市政道路施工封路方案协调与审批平台

源提示词编号：11。支持分段封路范围、施工阶段、绕行路线、车道收窄和临时设施的同一地图协作；检查相邻工程、救护通道、公交覆盖和绕行时延冲突；提供图层开关、路线绘制、阶段时间轴、条件会签、版本比较和公开通告包导出。

## 本次改造：接入「半小时道路容量账」

施工阶段、绕行路线、会签意见不再各自孤立，统一压到按 30 分钟计的道路容量账上：

- **共用路面识别**：阶段围挡、社会绕行、急救通道、公交通廊、相邻工程按坐标折成路链；绕行与急救/公交共线的路段在地图上金色描边（`src/ledger/engine/network.ts`）。
- **保底优先**：每个 `(日期, 半小时, 路链)` 一行账，先扣急救通道（全天 30 pcu/30min）与公交（服务时段 20 pcu/30min）最低能力，再核围挡/相邻工程扣减，最后才核社会绕行与已放行预占（`src/ledger/engine/ledger.ts`）。
- **容量不足**：放行申请不得超剩余能力；只能对亏空窗口「申请排队」并标明占用来源（精确到阶段/现场单号）。支持当日亏空逐窗批量排队。
- **两终端同窗口只放一笔**：跨标签页互斥锁 + 服务端「窗口唯一放行」双保险；输家立即返回占用来源的现场单号与终端，不占位（`src/ledger/capacityServer.ts`）。
- **写入失败按单号恢复**：现场单号全局幂等。弱网下响应丢失只挂「写入未知」并本地留底，绝不二次占位；恢复时先查服务端真相，查无才用原单号原内容补提。
- **变更失效重算**：阶段时间/路线/车道一变（容量账升版），旧预占转「已失效」、锚定会签转「失效待重签」，可按原单号在新账上重算。
- **导出闸门**：存在未覆盖亏空、写入未知、旧版本预占或失效会签时，公开通告导出被拦截；全部处置完才放行（会签页与容量页同源）。

### 演练路径

1. `npm run dev`，再开一个浏览器标签页（=第二个作业终端），在容量账页右上切到「终端 B」。
2. 容量账页选任一亏空窗口（红色「亏 N」），A、B 两终端几乎同时点提交 → 只成功一笔，另一笔看到占用单号。
3. 打开「弱网故障注入」后提交 → 出现「写入未知」，用「按现场单号恢复」，无论服务端是否已入账都不会重复占位。
4. 地图页改阶段开始时间/重绘路线 → 旧预占失效、关联会签变「失效待重签」，容量账版本 +1；回容量账对旧单「按新账重算」。
5. 会签页接受 CM-44（高峰补能）、CM-42（围挡内收保急救），对相邻工程叠加夜的亏空逐窗排队 → 闸门转绿后才能导出通告。

### 自动化校验

```bash
node_modules/.bin/esbuild scripts/verify-ledger.ts --bundle --platform=node --format=esm --outfile=/tmp/l.mjs && node /tmp/l.mjs
node_modules/.bin/esbuild src/ledger/capacityServer.ts --bundle --platform=node --format=esm --outfile=/tmp/s.mjs
sed 's#/workspace/src/ledger/capacityServer.ts#/tmp/s.mjs#' scripts/verify-server.mjs > /tmp/vs.mjs && node /tmp/vs.mjs
```

覆盖：保底先扣与亏空、会签补能/围挡减免、退回阶段不入账、排队覆盖亏空、旧版本失效重算、闸门放行；以及两终端同窗口唯一放行、WINDOW_TAKEN 来源、单号幂等恢复、弱网丢失不重复占位。

## 技术栈

Vue 3、Arco Design Vue、Pinia、Vue Router、Apollo Client、GraphQL、MapLibre GL、Vite、TypeScript。

## 运行

```bash
npm install
npm run dev
```

开发地址：http://localhost:62054

```bash
npm run build
```
