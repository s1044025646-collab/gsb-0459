# 筛分累计通过曲线与粒径区间核验后端

本地土样筛分数据分析服务（**仅 API 与 CLI，无前端**）。输入按筛孔直径**从大到小**排列的筛分级、每级筛上截留质量与底盘质量，计算累计通过曲线、指定百分位粒径 Dp（含零截留平台区间）与级配指标 Cu / Cc。

- 语言/运行时：TypeScript + Node.js（要求 Node ≥ 23，使用内置 `node:sqlite`，**无需原生模块编译**）
- 数据库：SQLite，数据文件位于项目内 `data/`
- 运行时第三方依赖：**零**（仅 devDependencies：typescript、@types/node）
- 不依赖 Docker / WSL / 付费服务 / 外部在线 API；不连接仪器；不引入沉降法、图像识别或颗粒形状模型
- 所有数据均为**虚构实验记录**；本服务**不作任何土壤工程安全结论**，也**不依据 Cu/Cc 自动宣称符合某建筑标准**

## 计算约定（务必先读）

### 质量账目（先验证后计算）

- 干样总质量 `totalDryMassMg` 必须为**正安全整数**毫克；每个筛上质量与底盘质量为**非负整数**毫克。
- 硬闭合条件：`Σ 各筛截留质量 + 底盘质量 === 干样总质量`（整数精确相等）。
- 不闭合直接拒绝（错误码 `MASS_NOT_BALANCED`），**不偷偷归一化、不把缺失质量摊给底盘**。
- 底盘**必须显式提供**（错误码 `MISSING_PAN`）。底盘只参与质量闭合，**不是直径为 0 的筛孔**，不参与对数插值。
- 限制：筛级数 ≤ 100；干样总质量 ≤ 10¹² mg；质量累加不得超出 JS 安全整数范围。

### 筛孔与累计

- 筛孔直径为正有限数（毫米），且必须**严格递减**；重复直径、颠倒顺序直接拒绝。
- 第 i 级累计截留 = 本筛及所有更粗筛截留之和（整数）。
- 通过质量 = 总质量 − 累计截留（整数）；通过率 = 通过质量 / **原总质量** × 100。
- 报告同时给出并**区分**：单级截留比例、累计截留比例、通过质量、通过率。
- 内部百分比保留完整精度；仅 `...Display` 字段（与 CSV）四舍五入到两位小数。**平台判定与插值一律使用未舍入的质量比例**——两份仅因显示两位小数而相同的通过率不会被误认为相等。

### Dp（通过率为 p% 时的粒径）

- `p` 仅接受 0–100 的**整数**，所有百分位同一套约定。
- 通过率随粒径减小而递减；插值只发生在**相邻两个实测通过率之间**：
  - 对 `ln(D)` 做线性插值：`ln(Dp) = w·ln(D细) + (1−w)·ln(D粗)`，再 `exp`；**绝不直接对直径线性平均**。
  - `w = (P粗 − p) / (P粗 − P细)`。
- `p` 恰等于**单个**观测点：直接返回该筛孔直径（`unique`）。
- `p` 恰等于**多个相邻筛级的同值通过率**（零截留台阶）：返回粒径**区间** `[最小筛孔, 最大筛孔]`，状态 `platform`（平台歧义），**不任取一端**。边界平台（如 D100）同样按区间返回。
- 目标不在实测通过率范围内：状态 `out_of_range`，**不外推**；最粗筛以上、最细筛以下均无额外测点，底盘不设为零直径。
- 每个结果附 `source`：插值所用上下测点、对数权重、公式，以及把 Dp 代回对数线段反算通过率的 `check`（核验偏差）。

### Cu / Cc

- 仅当 D10、D30、D60 **三者均为唯一正粒径**时计算：
  - `Cu = D60 / D10`
  - `Cc = D30² / (D10 × D60)`
- 任一为平台区间或超出观测范围，则 `cu`、`cc` 为 `null`，并在 `blockedReasons` 逐条列出缺失/歧义原因。
- 质量同比放大不改变任何通过率、Dp、Cu、Cc；直径同比放大 k 倍时 Dp 缩放 k 倍、Cu/Cc 不变（已有测试覆盖）。

### 已知样例（手算基准）

总质量 100 mg，筛孔 2 / 1 / 0.5 mm，截留 20 / 30 / 40 mg，底盘 10 mg：

- 累计通过率：**80%、50%、10%**
- D10 = **0.5**；D30 = **√0.5 ≈ 0.70710678**；D60 = **2^(1/3) ≈ 1.2599210**
- Cu ≈ **2.5198421**；Cc ≈ **0.7937005**

## 快速开始（Windows / PowerShell）

```powershell
node -v          # 需要 Node >= 23（开发环境为 v25.5.0）
npm install
npm run build    # tsc 编译到 dist/
npm test         # 编译 + 运行 node:test（17 个测试）
npm run demo     # 端到端演示：手算样例/平台/缺质量/超范围/幂等/重启/导出
npm start        # 启动 HTTP 服务，默认选择空闲端口并打印实际地址
```

服务环境变量：`PORT`（默认 `0` = 自动选择空闲端口；可固定，如 `8765`）、`HOST`（默认 `127.0.0.1`）、`DATA_DIR`（默认 `./data`）。

## HTTP API

所有请求/响应为 JSON（CSV 导出除外）。错误统一形如 `{"error":{"code","message","detail"}}`；参数校验失败 HTTP 422 且带 `issues[]`（每个问题含 `field/code/message/detail`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET  | `/health` | 健康检查 |
| POST | `/api/samples` | 建立样品，body `{"id"?: string, "name"?: string}` |
| GET  | `/api/samples` | 样品列表 |
| POST | `/api/sieve-versions/preview` | **预览**：完整校验并返回试算报告，**不写库** |
| POST | `/api/samples/{id}/versions` | 提交筛分版本；重复输入返回 `duplicated:true` 且不新增版本 |
| GET  | `/api/samples/{id}/versions` | 版本列表 |
| GET  | `/api/samples/{id}/versions/{n\|latest}/report` | 冻结报告（`?format=csv` 导出 CSV） |
| GET  | `/api/samples/{id}/versions/{n\|latest}/percentiles/{p}` | 查询任意合法百分位，附插值来源 |

请求体：

```json
{
  "totalDryMassMg": 100,
  "panMassMg": 10,
  "sieves": [
    { "diameterMm": 2, "retainedMg": 20 },
    { "diameterMm": 1, "retainedMg": 30 },
    { "diameterMm": 0.5, "retainedMg": 40 }
  ]
}
```

PowerShell 调用示例：

```powershell
$body = Get-Content -Raw examples/standard.json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<端口>/api/sieve-versions/preview -ContentType 'application/json' -Body $body
```

## CLI

```powershell
npm run cli -- sample-create --id smp1 --name "虚构样例"
npm run cli -- preview  --json examples/standard.json
npm run cli -- submit   --sample smp1 --json examples/standard.json
npm run cli -- version-list --sample smp1
npm run cli -- report   --sample smp1 --version latest
npm run cli -- report   --sample smp1 --csv --out report.csv
npm run cli -- dp       --sample smp1 --p 30
```

`--data-dir <目录>` 可放在任意位置（默认 `./data`）。导入失败（含预览）退出码非零且打印全部错误码；坏数据提交被数据库事务回滚，不留半份曲线。

## 数据与版本模型

- SQLite 文件：`<DATA_DIR>/sieve.db`（WAL）。表：`samples`、`versions`。
- 每次**修订**（总质量/底盘/任一直径或截留质量变化）生成新版本号；**幂等键**为输入的规范化哈希，重复提交不增加版本。
- 每个版本**冻结**保存原始输入与完整报告 JSON；旧报告永远引用当时的总质量与筛孔，互不影响。
- 任意百分位查询基于该冻结版本重算（报告未预存该 p 时即时计算），不改写历史。

## 错误码

`VALIDATION_TOTAL_MASS`、`VALIDATION_MASS_NOT_INTEGER`、`VALIDATION_MASS_TOO_LARGE`、`VALIDATION_MASS_NEGATIVE`、`MASS_NOT_BALANCED`、`MISSING_PAN`、`VALIDATION_SIEVES_EMPTY`、`VALIDATION_SIEVES_TOO_MANY`、`VALIDATION_DIAMETER_NOT_FINITE`、`VALIDATION_DIAMETER_NOT_POSITIVE`、`VALIDATION_DIAMETER_NOT_STRICT_DECREASING`、`INVALID_PERCENTILE`、`INVALID_PAYLOAD`、`NOT_FOUND`。

失败一律返回结构化解释，**不会用 NaN/Infinity 充当结果**；插值结果非有限数会被显式拦截。

## 范围与限制

- 只处理虚构筛分实验记录；不接仪器、不做工程判定、不评估标准符合性。
- 不做沉降法（细粒级）、图像分析、颗粒形状/密度修正。
- 观测范围之外不给 Dp（包括 D0/D100 未被实测覆盖时）；平台只给区间不给唯一值。
- 后端服务：无鉴权、仅绑定回环地址，供本地单机使用。

## 项目结构

```
src/validate.ts   参数与质量账目校验、错误码
src/engine.ts     累计曲线、ln(D) 插值、平台/超范围、Cu/Cc、冻结报告
src/db.ts         SQLite、事务、幂等版本、冻结存取
src/server.ts     HTTP API（node:http）
src/cli.ts        CLI
src/exporters.ts  CSV 导出
test/             node:test：手算累计、放大不变性、平台、单级筛、API、持久化
demo/demo.ts      端到端演示
examples/         标准样例、零截留平台、缺质量三份 JSON
```
