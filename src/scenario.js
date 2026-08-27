const analysisScenario = {
  id: 'monitor-three-seat-debate-improvement-v7',
  opening: '开始公开信息驱动的产业链信用风险分析。',
  branches: [
    {
      id: 'public_evidence_planning_and_intake',
      label: '产业链规划与单次公开证据采集',
      openingQuestion: '请由信息搜集角色提交产业链待验证规划，并据此完成一次公开信息采集和冻结。',
      requiredFields: ['industry_plan', 'normalized_case', 'evidence_registry', 'evidence_intake'],
      fields: {
        industry_plan: { type: 'object', required: ['执行员', '产业链', '传导逻辑', '证据需求'] },
        normalized_case: { type: 'object', required: ['contract_version', 'case_id', 'as_of_date', 'company', 'evidence', 'industry_plan'] },
        evidence_registry: { type: 'array', minItems: 2 },
        evidence_intake: { type: 'object', required: ['mode', 'public_information_only', 'evidence_count'] }
      }
    },
    {
      id: 'information_collection_monitoring',
      label: '公开信息搜集与监控',
      openingQuestion: '请提交仅含已发布公开信息的证据账本和主动或被动监控记录。',
      requiredFields: ['monitoring_record', 'monitor_assessment'],
      fields: {
        monitoring_record: { type: 'object', required: ['mode', 'public_information_only', 'eligible_evidence_ids', 'cutoff_verified'] },
        monitor_assessment: { type: 'object', required: ['agent_id', 'relevant_evidence_ids', 'topic_signals', 'abstain'] }
      }
    },
    {
      id: 'group_debate',
      label: '三席两阶段群组辩论',
      openingQuestion: '请提交同一三个席位对授信方向和风控建议的四模块答案、差异自审与表决记录；不产生席间质疑记录。',
      requiredFields: ['panel_opinions', 'revised_opinions', 'debate_record'],
      fields: {
        panel_opinions: { type: 'array', minItems: 3 },
        revised_opinions: { type: 'array', minItems: 3 },
        debate_record: { type: 'object', required: ['participant_agent_ids', 'rules', 'rounds', 'termination'] },
        shadow_opinions: { type: 'array' }
      }
    },
    {
      id: 'conclusion_output',
      label: '确定性结论输出',
      openingQuestion: '请提交由程序根据三席表决结果无损生成的授信动作和风控建议；禁止新增结论模型。',
      requiredFields: ['consensus', 'credit_strategy'],
      fields: {
        consensus: { type: 'object', required: ['probabilities', 'action', 'risk_control_advice'] },
        credit_strategy: { type: 'object', required: ['agent_id', 'action', 'risk_control_advice', 'strategy_summary'] }
      }
    }
  ],
  output: {
    contract_version: '2.0.0',
    required: ['industry_plan', 'normalized_case', 'evidence_registry', 'evidence_intake', 'monitoring_record', 'monitor_assessment', 'panel_opinions', 'revised_opinions', 'debate_record', 'consensus', 'credit_strategy']
  }
}

const deliveryScenario = {
  id: 'credit-risk-delivery-v1',
  opening: '开始冻结分析结果的稳定交付。',
  branches: [
    {
      id: 'frozen_analysis',
      label: '冻结分析输入',
      openingQuestion: '请提交不可变分析快照及其哈希。',
      requiredFields: ['analysis_snapshot', 'analysis_sha256'],
      fields: {
        analysis_snapshot: { type: 'object', required: ['scenarioId', 'fields', 'frozenAt'] },
        analysis_sha256: { type: 'string', minLength: 64, maxLength: 64 }
      }
    },
    {
      id: 'delivery_qa',
      label: '报告与交付门禁',
      openingQuestion: '请提交符合版本化契约且通过 QA 的报告。',
      requiredFields: ['report'],
      fields: { report: { type: 'object', required: ['contract_version', 'submission_row', 'qa'] } }
    }
  ],
  output: { contract_version: '1.0.0', required: ['analysis_snapshot', 'analysis_sha256', 'report'] }
}

const evolutionScenario = {
  id: 'debate-agent-evolution-supervisor-v2',
  opening: '开始基于外部真值的辩论 Agent 同席 Champion/Challenger 评估。',
  branches: [
    {
      id: 'labeled_batch',
      label: '独立真值批次',
      openingQuestion: '请提交无重复、无未来信息的已揭晓标签批次。',
      requiredFields: ['batch_manifest', 'outcomes'],
      fields: {
        batch_manifest: { type: 'object', required: ['checkpoint', 'case_count', 'cutoff_verified'] },
        outcomes: { type: 'array', minItems: 1 }
      }
    },
    {
      id: 'scorecard',
      label: '程序评分',
      openingQuestion: '请提交同一角色 Champion 与影子 Challenger 的配对样本外评分及硬门禁结果。',
      requiredFields: ['scorecard'],
      fields: { scorecard: { type: 'object', required: ['role_comparisons', 'metrics', 'hard_failures'] } }
    },
    {
      id: 'promotion_decision',
      label: '挑战者晋升或保留',
      openingQuestion: '请提交程序决定的保留、影子测试、晋升或淘汰结果。',
      requiredFields: ['evolution_decision'],
      fields: { evolution_decision: { type: 'object', required: ['action', 'reason', 'lineage'] } }
    }
  ],
  output: { contract_version: '1.0.0', required: ['batch_manifest', 'scorecard', 'evolution_decision'] }
}

module.exports = { analysisScenario, deliveryScenario, evolutionScenario, scenario: analysisScenario }
