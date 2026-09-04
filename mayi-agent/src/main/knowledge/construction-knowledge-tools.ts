import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ConstructionKnowledgeService } from './construction-knowledge-service'

export const KNOWLEDGE_SERVER_NAME = 'mayi-construction-knowledge'
export const KNOWLEDGE_QUERY_TOOL = `mcp__${KNOWLEDGE_SERVER_NAME}__query_standard`
export const KNOWLEDGE_SNAPSHOT_TOOL = `mcp__${KNOWLEDGE_SERVER_NAME}__create_project_standard_snapshot`
export const KNOWLEDGE_LATEST_SNAPSHOT_TOOL = `mcp__${KNOWLEDGE_SERVER_NAME}__latest_project_standard_snapshot`
export const METHOD_QUERY_TOOL = `mcp__${KNOWLEDGE_SERVER_NAME}__query_method_cards`
export const METHOD_SNAPSHOT_TOOL = `mcp__${KNOWLEDGE_SERVER_NAME}__create_project_method_snapshot`
export const METHOD_LATEST_SNAPSHOT_TOOL = `mcp__${KNOWLEDGE_SERVER_NAME}__latest_project_method_snapshot`
export const STANDARD_VALIDATION_TOOL = `mcp__${KNOWLEDGE_SERVER_NAME}__validate_standard_references`
export const KNOWLEDGE_IMPACTS_TOOL = `mcp__${KNOWLEDGE_SERVER_NAME}__list_project_knowledge_impacts`

export function getConstructionKnowledgeToolNames(enabledSkillIds: string[]): string[] {
  const names: string[] = []
  if (enabledSkillIds.includes('construction-standard-registry')) {
    names.push(KNOWLEDGE_QUERY_TOOL, KNOWLEDGE_SNAPSHOT_TOOL, KNOWLEDGE_LATEST_SNAPSHOT_TOOL)
  }
  if (enabledSkillIds.includes('municipal-construction-methods')) {
    names.push(METHOD_QUERY_TOOL, METHOD_SNAPSHOT_TOOL, METHOD_LATEST_SNAPSHOT_TOOL)
  }
  if (enabledSkillIds.includes('construction-standard-validation')) {
    names.push(STANDARD_VALIDATION_TOOL, KNOWLEDGE_IMPACTS_TOOL)
  }
  return names
}

/** 为单次会话创建绑定可信 sessionId 的内嵌标准知识工具。 */
export function createConstructionKnowledgeServer(
  service: ConstructionKnowledgeService,
  sessionId: string,
  enabledSkillIds: string[]
) {
  const tools = []
  if (enabledSkillIds.includes('construction-standard-registry')) {
    tools.push(
      tool(
        'query_standard',
        '按标准编号、地区、专业和项目适用日期查询受控标准缓存。',
        {
          code: z.string().min(1).max(80),
          jurisdiction: z.string().min(1).max(100),
          discipline: z.string().min(1).max(100).optional(),
          applicableDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          purpose: z.enum(['draft', 'formal'])
        },
        async (input) => ({
          content: [{ type: 'text', text: JSON.stringify(await service.queryStandard(input)) }]
        })
      ),
      tool(
        'create_project_standard_snapshot',
        '为当前会话创建不可变项目标准快照；会话和工作区由主进程绑定。',
        {
          applicableDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          mode: z.enum(['draft', 'formal']),
          standards: z
            .array(
              z.object({
                versionId: z.string().uuid(),
                selectionReason: z.enum(['tender', 'design', 'mandatory', 'regional', 'method'])
              })
            )
            .min(1)
            .max(200)
        },
        async (input) => ({
          content: [{
            type: 'text',
            text: JSON.stringify(service.createProjectSnapshot({ ...input, sessionId }))
          }]
        })
      ),
      tool(
        'latest_project_standard_snapshot',
        '读取当前会话最近一次由主进程生成的项目标准快照。',
        {},
        async () => ({
          content: [{
            type: 'text',
            text: JSON.stringify(service.getLatestProjectSnapshot(sessionId) || null)
          }]
        })
      )
    )
  }
  if (enabledSkillIds.includes('municipal-construction-methods')) {
    tools.push(
      tool(
        'query_method_cards',
        '按项目事实标识和专业查询经过版本管理的市政工法卡。',
        {
          disciplines: z.array(z.enum(['road', 'drainage', 'utility', 'traffic', 'lighting', 'landscape', 'common'])).min(1).max(7),
          factIds: z.array(z.string().min(1).max(100)).min(1).max(200),
          mode: z.enum(['draft', 'formal']),
          limit: z.number().int().min(1).max(50).optional()
        },
        async (input) => ({
          content: [{
            type: 'text',
            text: JSON.stringify(service.matchMethodCards({ ...input, sessionId }))
          }]
        })
      ),
      tool(
        'create_project_method_snapshot',
        '将选定工法卡版本冻结为当前项目的不可变工法快照。',
        {
          factsHash: z.string().regex(/^[0-9a-f]{64}$/),
          standardSnapshotId: z.string().uuid().optional(),
          mode: z.enum(['draft', 'formal']),
          methods: z.array(z.object({
            methodVersionId: z.string().uuid(),
            selectionReason: z.enum(['entity', 'risk', 'tender', 'design', 'user'])
          })).min(1).max(100)
        },
        async (input) => ({
          content: [{
            type: 'text',
            text: JSON.stringify(service.createProjectMethodSnapshot({ ...input, sessionId }))
          }]
        })
      ),
      tool(
        'latest_project_method_snapshot',
        '读取当前项目最近一次工法快照。',
        {},
        async () => ({
          content: [{
            type: 'text',
            text: JSON.stringify(service.getLatestProjectMethodSnapshot(sessionId) || null)
          }]
        })
      )
    )
  }
  if (enabledSkillIds.includes('construction-standard-validation')) {
    tools.push(
      tool(
        'validate_standard_references',
        '校验正文、策划和工法卡中的结构化标准引用并生成项目报告。',
        {
          applicableDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          mode: z.enum(['draft', 'formal']),
          references: z.array(z.object({
            rawCode: z.string().min(1).max(80),
            rawTitle: z.string().min(1).max(300).optional(),
            clauseRef: z.string().min(1).max(80).optional(),
            sourceType: z.enum(['method_card', 'chapter', 'planning', 'tender', 'design']),
            sourceId: z.string().min(1).max(200),
            sourceLocation: z.string().min(1).max(500).optional()
          })).min(1).max(500)
        },
        async (input) => ({
          content: [{
            type: 'text',
            text: JSON.stringify(service.validateStandardReferences({ ...input, sessionId }))
          }]
        })
      ),
      tool(
        'list_project_knowledge_impacts',
        '读取当前项目因标准状态变化产生的未关闭复核影响。',
        {},
        async () => ({
          content: [{
            type: 'text',
            text: JSON.stringify(service.listProjectKnowledgeImpacts(sessionId))
          }]
        })
      )
    )
  }
  return createSdkMcpServer({
    name: KNOWLEDGE_SERVER_NAME,
    version: '1.0.0',
    instructions:
      '标准效力只能以这些工具返回的数据和主进程生成的项目快照为准；待审核或查询失败必须列为未决事项。',
    tools
  })
}
