<p align="center">
  <img src="assets/brand/rulora-logo-256.png" width="128" alt="Rulora Logo">
</p>

# Rulora Collective Decision

## 项目说明

本案例已经过自动化测试和场景验证，但仍处于研究与持续演进阶段，可能存在架构、性能、安全或
兼容性问题。欢迎带着复现步骤、评估数据和改进方案参与讨论与优化，共同把开源版本改进成更可靠
的产品。

一个经过脱敏的 **Agent 群体控制与信贷风险研究案例**。它保留原系统的多席独立判断、候选池、
法定人数、受限 Reviewer、检查点、恢复和本地页面，但不包含真实企业数据、真实 API 密钥、
比赛数据集或历史运行产物。

本项目是 [Rulora](https://github.com/Buffalo2024/Rulora) 的独立场景案例，与
[Report Agent](https://github.com/Buffalo2024/Rulora-Report-Agent) 和
[AGTI](https://github.com/Buffalo2024/Rulora-AGTI) 使用同一套模型与程序职责边界，但保留
独立源码、协议、测试和发布节奏。

> 研究状态：由于缺少足够的标注训练数据与独立评估数据，当前风险方向和风控建议的准确性尚不高。
> 本项目不能用于真实授信、拒贷、定价或其他影响个人与企业权益的自动决策。开源的目的之一，
> 是获得更严格的数据、评估与工程反馈，把原型逐步改进成更可靠的产品。

## 保留的数字决策协议

- `action = -1`：风险上升，授信方向收紧；
- `action = 0`：风险基本稳定，维持；
- `action = 1`：风险下降，可评估放宽；
- `risk_control_advice = ["1".."9"]`：确定性风控建议目录代码。代码含义由
  `src/risk-control-advice.js` 统一查表，模型不能自行创造新代码。

这些数字是机器协议，不是主观评分。最终页面同时显示中文解释，避免只展示难懂的代码。

## 核心分工

- **LLM** 负责理解证据、开放语义推理、独立判断和候选选择；
- **Program** 负责流程状态、字段合同、校验、统计、候选池、门禁和最终结果；
- **Recovery** 只修复 JSON 或 Markdown 载体，不推断业务答案；
- **Adapter** 只做字段别名与确定性类型转换，不增删或修改结论；
- **Reviewer** 只选择 Program 冻结的候选 ID，不重新创造答案；
- **Loop** 区分网络重连、约束修订和业务广播，全部有次数上限；
- **Checkpoint** 保证只恢复失败节点，不重复调用成功节点；
- **Improvement 席** 只利用客观反馈改进下一版本，不在运行中自改。

## 控制链路

```text
虚构企业输入 → 证据冻结 → 三席独立候选 → Action 冻结
             → 风控建议候选池 → 受限 Reviewer → 一致性门禁 → 交付与恢复
```

Reviewer 只能选择冻结候选池中的 ID；候选不足法定人数时流程失败，不用程序默认值代替群体判断。
模型输出先经过 Recovery 和 Adapter，再由 Core/Audit 契约校验。成功节点写入检查点，恢复时只重跑
失败节点。

## LangGraph 最小参考应用

仓库现在包含一个不需要 API Key 的最小 LangGraph 案例，用于单独展示
`Recovery → Adapter → 候选冻结 → 受限 Reviewer → JSON 交付`。案例同时将各角色可见字段
实现为 Program 白名单，而不只是 Prompt 约定。

```bash
npm run example:langgraph
npm run test:minimal
npm run eval:reliability
npx @langchain/langgraph-cli dev --no-browser
```

设计边界、拒绝路径和可量化的稳定性指标见
[`docs/langgraph-reference-application.md`](docs/langgraph-reference-application.md)。

当前版本化小样本包含 10 个载体/语义故障案例、3 个 Reviewer 候选选择案例和 3 类
角色披露视图。评估结果只证明这个公开小样本中的确定性约束，不代表模型判断准确率，
也不代表所有模型输出的通用稳定率。

## 本地运行

要求 Node.js 20+：

```bash
npm install
npm test
npm run example
```

默认示例只使用 `examples/company-case.json` 中的虚构企业和 fixture/deterministic provider，
不需要真实 API。若接入模型，请复制 `.env.example` 并只通过环境变量提供密钥。

本地控制台可通过 `npm run web` 启动。它提供 25 家虚构演示企业、单家或批量企业导入、
三席分析进度、异常对话和交付结果查看。每个任务使用独立检查点；任务失败或本地服务重启后，
用户可以在原任务上确认从断点继续，不重复调用已经成功的节点。

如果三席无法形成满足门槛的授信方向，程序会在进入风控措施阶段前暂停。用户可以保留三席原始
意见并进行人工裁决，也可以清除本次模型调用检查点后重新分析。页面的“演示脱敏模式”只替换
当前浏览器中的可见企业标识，不改变后台记录、模型输入或最终产物。

## 数据边界

本仓库禁止提交：真实企业或个人信息、征信与授信记录、比赛隐藏数据、模型响应缓存、API 密钥、
本地绝对路径及 `.runtime/` 运行目录。公开来源连接器只是可选边界，不是本项目的核心能力。

## 联系与合作

- 邮箱：`zzjeff1993.agent@gmail.com`
- GitHub Issues：用于提交可复现缺陷、评估建议和协议改进
- 微信：扫描下方二维码，请注明 `Collective Decision`

<p align="center">
  <img src="assets/contact/wechat-qr.jpg" width="220" alt="微信联系二维码">
</p>

## License

Apache-2.0。示例仅供研究、教学与工程验证。
