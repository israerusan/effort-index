/** Topic-clustered effort reporting (DESIGN 8.3). Pure — see clusters.mjs. */

import type { ExpensiveRow } from "./expensive.d.mts";

export const DEFAULT_CLUSTER_MIN_SCORE: number;
export const MIN_CLUSTER_SIZE: number;

/** One engine hit: `from` is the note we queried with, `to` the note that came back. */
export interface TopicEdge {
	from: string;
	to: string;
	score: number;
}

export interface ClusterMember extends ExpensiveRow {
	/** Similarity to the cluster's seed. The seed itself is 1. */
	score: number;
	seed: boolean;
}

export interface TopicCluster {
	id: string;
	/** The seed note's title. A cluster is named after the note it formed around. */
	label: string;
	seed: string;
	notes: ClusterMember[];
	size: number;
	/** Total measured editing time across the cluster — what the topic actually cost. */
	editMs: number;
}

export interface TopicClustering {
	clusters: TopicCluster[];
	/** Notes with no neighbour above the bar. Visible, never dropped. */
	ungrouped: ExpensiveRow[];
	/** How many notes landed in a cluster. */
	grouped: number;
}

export function noteTitle(path: string): string;

export function buildAdjacency(edges: TopicEdge[], minScore: number): Map<string, Map<string, number>>;

export function clusterByTopic(
	rows: ExpensiveRow[],
	edges: TopicEdge[],
	opts?: { minScore?: number; limit?: number }
): TopicClustering;
