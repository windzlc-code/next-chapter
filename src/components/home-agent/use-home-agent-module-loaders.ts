import * as React from "react";
import * as apiConfigModule from "@/lib/api-config";
import type { HomeAgentApiConfigModule, HomeAgentEngineDeps } from "./home-agent-engine-runtime";

const { useCallback, useRef } = React;

export type ProjectStoreModule = typeof import("@/lib/home-agent/project-store");
export type AskUserQuestionModule = typeof import("@/lib/agent/tools/ask-user-question");
export type StructuredQuestionParserModule = typeof import("./structured-question-parser");
export type WorkflowActionsModule = typeof import("@/lib/home-agent/workflow-actions");
export type SemanticSummaryModule = typeof import("@/lib/home-agent/conversation-semantic-summary");
export type ConversationMemoryModule = typeof import("@/lib/home-agent/conversation-memory");

export function useHomeAgentModuleLoaders() {
  const engineDepsRef = useRef<Promise<HomeAgentEngineDeps> | null>(null);
  const projectStoreRef = useRef<Promise<ProjectStoreModule> | null>(null);
  const apiConfigRef = useRef<Promise<HomeAgentApiConfigModule> | null>(null);
  const askQuestionRef = useRef<Promise<AskUserQuestionModule> | null>(null);
  const structuredParserRef = useRef<Promise<StructuredQuestionParserModule> | null>(null);
  const workflowActionsRef = useRef<Promise<WorkflowActionsModule> | null>(null);
  const semanticSummaryRef = useRef<Promise<SemanticSummaryModule> | null>(null);
  const conversationMemoryRef = useRef<Promise<ConversationMemoryModule> | null>(null);

  const loadEngineDeps = useCallback(async () => {
    if (!engineDepsRef.current) {
      engineDepsRef.current = import("@/lib/agent/tools").then((toolsModule) => ({
        createDefaultTools: toolsModule.createDefaultTools,
      }));
    }
    return engineDepsRef.current;
  }, []);

  const loadProjectStore = useCallback(async () => {
    if (!projectStoreRef.current) {
      projectStoreRef.current = import("@/lib/home-agent/project-store");
    }
    return projectStoreRef.current;
  }, []);

  const loadApiConfigModule = useCallback(async () => {
    if (!apiConfigRef.current) {
      apiConfigRef.current = Promise.resolve(apiConfigModule);
    }
    return apiConfigRef.current;
  }, []);

  const loadAskUserQuestionModule = useCallback(async () => {
    if (!askQuestionRef.current) {
      askQuestionRef.current = import("@/lib/agent/tools/ask-user-question");
    }
    return askQuestionRef.current;
  }, []);

  const loadStructuredQuestionParser = useCallback(async () => {
    if (!structuredParserRef.current) {
      structuredParserRef.current = import("./structured-question-parser");
    }
    return structuredParserRef.current;
  }, []);

  const loadWorkflowActionsModule = useCallback(async () => {
    if (!workflowActionsRef.current) {
      workflowActionsRef.current = import("@/lib/home-agent/workflow-actions");
    }
    return workflowActionsRef.current;
  }, []);

  const loadSemanticSummaryModule = useCallback(async () => {
    if (!semanticSummaryRef.current) {
      semanticSummaryRef.current = import("@/lib/home-agent/conversation-semantic-summary");
    }
    return semanticSummaryRef.current;
  }, []);

  const loadConversationMemoryModule = useCallback(async () => {
    if (!conversationMemoryRef.current) {
      conversationMemoryRef.current = import("@/lib/home-agent/conversation-memory");
    }
    return conversationMemoryRef.current;
  }, []);

  return {
    loadEngineDeps,
    loadProjectStore,
    loadApiConfigModule,
    loadAskUserQuestionModule,
    loadStructuredQuestionParser,
    loadWorkflowActionsModule,
    loadSemanticSummaryModule,
    loadConversationMemoryModule,
  };
}
