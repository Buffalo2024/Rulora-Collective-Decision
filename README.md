<p align="center">
  <img src="assets/brand/rulora-logo-256.png" width="128" alt="Rulora Logo">
</p>

# Rulora Collective Decision

## 作者与项目说明

本案例及 Rulora 由一名没有专业编程背景的作者通过 **Vibe Coding** 创建。虽然代码经过自动化
测试和场景验证，仍可能存在架构、性能、安全或兼容性问题。欢迎带着复现步骤、评估数据和改进
方案参与讨论与优化，希望通过开源把原型逐步改进成更可靠的产品。

一个经过脱敏的 **Agent 群体控制与信贷风险研究案例**。它保留原系统的多席独立判断、候选池、
法定人数、受限 Reviewer、检查点、恢复和本地页面，但不包含真实企业数据、真实 API 密钥、
比赛数据集或历史运行产物。

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

## 本地运行

要求 Node.js 20+：

```bash
npm install
npm test
npm run example
```

默认示例只使用 `examples/company-case.json` 中的虚构企业和 fixture/deterministic provider，
不需要真实 API。若接入模型，请复制 `.env.example` 并只通过环境变量提供密钥。

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
