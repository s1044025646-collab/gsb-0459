# 筛分累计通过曲线与粒径区间核验后端

本地运行的**虚构土样筛分实验**数据分析服务，只提供 HTTP API 与命令行（CLI）。
使用 TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，无需本地编译原生模块）。

> 范围限制：本服务只处理质量累计与对数粒径插值，**不连接仪器、不引入沉降法/图像识别/颗粒形状模型，也不依据 Cu、Cc 给出任何土壤工程或建筑标准符合性结论**。所有数据均为人工录入的虚构实验记录。

## 环境要求

- Windows 本地，Node.js **v22.5+**（开发验证于 v25.5.0，需要内置 `node:sqlite`）
- 不需要 Docker、WSL、付费服务或任何外部在线 API

## 快速开始

```powershell
npm install
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo       # 运行端到端中文演示（CLI，自动写样例数据）
```

固定端口 / 自定义数据目录：

```powershell
$env:PORT="8731"                  # 固定端口；不设则自动选空闲端口
$env:SIEVE_DATA_DIR="E:\sieve-data"  # 默认 ./data
npm start
```

## 输入约定

所有直径单位为**毫米**，所有质量为**整数毫克**。筛孔按**从粗到细（严格递减）**排列。

```json
{
  "dryTotalMg": 100,
  "panMg": 10,
  "sieves": [
    { "diameterMm": 2,   "retainedMg": 20 },
    { "diameterMm": 1,   "retainedMg": 30 },
    { "diameterMm": 0.5, "retainedMg": 40 }
  ]
}
```

### 质量账目规则（先核账，后计算）

- `dryTotalMg` 必须为**正的安全整数**；每个筛上质量与底盘质量为**非负整数**。
- 全部筛上质量与底盘质量之和必须**精确等于**干样总质量。
- **不做归一化，不把缺失质量偷偷摊给底盘**；不闭合直接以错误码 `MASS_NOT_BALANCED` 拒绝。
- 直径必须是正有限数且**严格递减**；重复直径、颠倒顺序返回 `DIAMETER_NOT_STRICTLY_DECREASING`。
- 底盘字段必须显式提供，缺失返回 `PAN_MISSING`。
- 筛级数上限 64（`MAX_SIEVES`），质量受安全整数范围约束。

## 计算口径

- **累计截留** = 本筛及所有更粗筛截留之和（整数求和，无浮点误差）。
- **通过质量** = 干样总质量 − 累计截留；**通过百分比** = 通过质量 / 干样总质量 × 100。
- 每级同时给出**单级截留比例**与**累计截留比例**，二者明确区分。
- `percentPassing` 为**未舍入**值，用于平台判断与插值；`percentPassingDisplay` 四舍五入两位小数，仅供展示。两份本就不同的通过率**不会**因显示舍入而被误判相等。
- 底盘**仅用于质量闭合**，不被当作直径 0 的筛孔参与插值；最粗筛以上、最细筛以下都不添加额外测点。

## 百分位 Dp 与平台歧义

对整数 `p ∈ [0,100]`，求通过率为 `p%` 时的粒径：

- 严格落在相邻两个**不同**实测通过率之间：对 `ln(直径)` 作线性插值后取指数
  `ln(D) = (1−w)·ln(D粗) + w·ln(D细)`，其中 `w` 按通过百分比（等价通过质量）线性取值——**不是**对直径做线性平均。
- `p` 恰等于某个观测点：返回该直径（`unique`）。
- 多个**相邻**筛级通过率相同且都等于 `p`（零截留造成的平台）：返回 `[最小筛孔, 最大筛孔]` 区间并标记 `kind="plateau"`，**不**任挑一端称为唯一 Dp。
- 目标超出实测通过率范围（最粗筛以上或最细筛以下）：返回 `kind="out-of-range"` 与中文原因，**绝不外推**，也不把底盘直径设为 0。
- 每个结果带 `source`（`exact-point` / `log-interpolation` / `plateau` / `none`）及两端观测点、插值权重，便于审计与代回核验。

## 级配指标

计算 D10、D30、D60 后，仅当三者都是**唯一正粒径**时才给出：

- `Cu = D60 / D10`
- `Cc = D30² / (D10 · D60)`

否则 `Cu`、`Cc` 为 `null`，并在 `reasons` 中逐项列出缺失或歧义原因（平台/超出观测范围）。系统**不**据此宣称符合任何建筑标准。

### 内置参考样例（`examples/known.json`）

总质量 100 mg，筛孔 2/1/0.5 mm，截留 20/30/40，底盘 10：
通过率 80% / 50% / 10%，且

- `D10 = 0.5`
- `D30 = √0.5 ≈ 0.7071068`
- `D60 = 2^(1/3) ≈ 1.2599211`
- `Cu ≈ 2.5198421`
- `Cc ≈ 0.7937005`

## 版本与冻结

- 每次提交生成一个**版本**；修订实验数据生成**新版本号**，旧报告继续引用当时的总质量与筛孔（报告整体以 JSON 冻结存储）。
- 相同输入（按规范化 SHA-256 去重）重复提交**幂等**，不新增版本。
- 导入/提交在数据库事务内完成，校验失败**回滚**，不留下半份曲线。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/samples` | 列出样品 |
| POST | `/api/samples` | 建立样品，body `{"name"?: string}` |
| POST | `/api/preview` | 预览导入错误（不落库），成功时附带试算报告；失败 HTTP 422 |
| GET | `/api/samples/:id/versions` | 列出版本 |
| POST | `/api/samples/:id/versions` | 提交筛分版本，body 为输入，可选 `"targets":[10,30,60]` |
| GET | `/api/samples/:id/curve?version=n` | 查看冻结报告（省略 version 取最新） |
| GET | `/api/samples/:id/percentile/:p?version=n` | 查询任意 0..100 整数百分位及插值来源 |
| GET | `/api/samples/:id/export?format=json\|csv&version=n` | 导出 JSON / CSV |

错误响应统一为 `{"error":{"code","message","details"}}`。

### 错误码

`VALIDATION_ERROR`、`TOTAL_NOT_POSITIVE_INTEGER`、`MASS_NOT_NONNEGATIVE_INTEGER`、
`MASS_NOT_BALANCED`、`SIEVES_EMPTY`、`TOO_MANY_SIEVES`、`DIAMETER_INVALID`、
`DIAMETER_NOT_STRICTLY_DECREASING`、`MASS_TOO_LARGE`、`PAN_MISSING`、
`PERCENTILE_INVALID`、`NOT_FOUND`、`CONFLICT`、`INTERNAL_ERROR`。

### curl 示例（PowerShell）

```powershell
curl.exe -s -X POST http://127.0.0.1:8731/api/samples -H "content-type: application/json" --data-binary "@examples/known.json"
# 先建样品得到 id（假设为 1）：
curl.exe -s -X POST http://127.0.0.1:8731/api/samples/1/versions -H "content-type: application/json" --data-binary "@examples/known.json"
curl.exe -s http://127.0.0.1:8731/api/samples/1/percentile/30
curl.exe -s "http://127.0.0.1:8731/api/samples/1/export?format=csv"
```

## CLI

```powershell
node dist/src/cli.js init-sample --name 我的样品
node dist/src/cli.js preview  --input examples/known.json
node dist/src/cli.js submit   --sample 1 --input examples/known.json --targets 10,30,60
node dist/src/cli.js versions --sample 1
node dist/src/cli.js curve    --sample 1 --version 1
node dist/src/cli.js percentile --sample 1 --p 30
node dist/src/cli.js export   --sample 1 --format csv --out curve.csv
node dist/src/cli.js demo
node dist/src/cli.js help
```

## 平台（platform）与观测范围限制（重要）

- 某一级**零截留**会让相邻两个筛孔的通过率完全相同，形成水平平台。落在该通过率上的 Dp **没有唯一答案**，本服务返回闭区间并标记 `plateau`，调用方需自行决定如何使用，不能把它当成单点。
- 可确定的通过率上界是**最粗筛**的实测通过率，下界是**最细筛**的实测通过率。底盘里的颗粒只说明“比最细筛更细”，但底盘**没有直径**，因此最细筛以下无法插值；最粗筛以上同理。二者一律 `out-of-range`，不外推。
- 边界平台（例如全部截留为 0 时的 D100）同样按区间返回。

## 项目结构

```
src/
  types.ts       类型定义
  errors.ts      错误码与 AppError
  validation.ts  质量账目与筛孔校验
  curve.ts       累计/百分比/对数插值/Cu/Cc（纯函数）
  export.ts      JSON / CSV
  db.ts          SQLite 样品/版本/冻结报告
  service.ts     编排（预览、提交、查询、导出）
  server.ts      HTTP 路由
  index.ts       启动入口（空闲端口）
  cli.ts         命令行
  demo.ts        中文端到端演示
test/            纯计算与持久化测试
examples/        参考输入
data/            运行期 SQLite（自动创建，已 gitignore）
```
