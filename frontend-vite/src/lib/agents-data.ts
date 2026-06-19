export type Agent = {
  id: string;
  name: string;
  status: "RUNNING" | "IDLE" | "ERROR";
  tasks: number;
  tokens: string;
  lastActive: string;
  uptime: string;
  success_rate: string;
  current_task: string;
};

export const DEMO_AGENTS: Agent[] = [
  {
    id: "ext-8829",
    name: "DataExtractor_v2",
    status: "RUNNING",
    tasks: 12,
    tokens: "2.4M",
    lastActive: "2 min ago",
    uptime: "14d 2h",
    success_rate: "99.2%",
    current_task: "Extracting Q3 earnings...",
  },
  {
    id: "agt-1024",
    name: "CodeAnalyzer_Beta",
    status: "RUNNING",
    tasks: 8,
    tokens: "1.8M",
    lastActive: "5 min ago",
    uptime: "5d 12h",
    success_rate: "98.5%",
    current_task: "Processing daily news feeds",
  },
  {
    id: "rtr-5021",
    name: "LangRouter_EU",
    status: "IDLE",
    tasks: 0,
    tokens: "850K",
    lastActive: "1 hour ago",
    uptime: "30d+",
    success_rate: "99.9%",
    current_task: "Waiting for events",
  },
  {
    id: "vec-3341",
    name: "VectorIndexer_Prod",
    status: "RUNNING",
    tasks: 15,
    tokens: "3.2M",
    lastActive: "1 min ago",
    uptime: "45d 3h",
    success_rate: "99.1%",
    current_task: "Indexing embeddings",
  },
  {
    id: "cache-2819",
    name: "CacheManager_v1",
    status: "RUNNING",
    tasks: 5,
    tokens: "560K",
    lastActive: "3 min ago",
    uptime: "22d 14h",
    success_rate: "98.8%",
    current_task: "Syncing cache layers",
  },
  {
    id: "gat-9102",
    name: "GatewayRouter",
    status: "RUNNING",
    tasks: 20,
    tokens: "4.1M",
    lastActive: "Just now",
    uptime: "60d+",
    success_rate: "99.7%",
    current_task: "Routing requests",
  },
  {
    id: "err-0042",
    name: "SentimentAnalyzer",
    status: "ERROR",
    tasks: 0,
    tokens: "120K",
    lastActive: "12 min ago",
    uptime: "2d 8h",
    success_rate: "87.3%",
    current_task: "OOMError: process killed",
  },
];
