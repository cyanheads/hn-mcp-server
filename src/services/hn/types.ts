/**
 * @fileoverview HN API domain types for Firebase and Algolia responses.
 * @module services/hn/types
 */

/** Raw item from the HN Firebase API. */
export interface HnItem {
  by?: string;
  dead?: boolean;
  deleted?: boolean;
  descendants?: number;
  id: number;
  kids?: number[];
  parent?: number;
  parts?: number[];
  poll?: number;
  score?: number;
  text?: string;
  time?: number;
  title?: string;
  type: 'story' | 'comment' | 'job' | 'poll' | 'pollopt';
  url?: string;
}

/** Raw user from the HN Firebase API. */
export interface HnUser {
  about?: string;
  created: number;
  delay?: number;
  id: string;
  karma: number;
  submitted?: number[];
}

/** Available HN feed types. */
export type HnFeedType = 'top' | 'new' | 'best' | 'ask' | 'show' | 'jobs';

/** Raw Algolia search response. */
export interface AlgoliaResponse {
  hits: AlgoliaHit[];
  hitsPerPage: number;
  nbHits: number;
  nbPages: number;
  page: number;
}

/**
 * Algolia per-field highlight metadata. The `value` is the original field text
 * with matched terms wrapped in `<em>…</em>` (default highlight markup).
 */
export interface AlgoliaHighlightValue {
  fullyHighlighted?: boolean;
  matchedWords: string[];
  matchLevel: 'none' | 'partial' | 'full';
  value: string;
}

/** Individual Algolia search hit. */
export interface AlgoliaHit {
  _highlightResult?: {
    title?: AlgoliaHighlightValue;
    url?: AlgoliaHighlightValue;
    author?: AlgoliaHighlightValue;
    comment_text?: AlgoliaHighlightValue;
    story_text?: AlgoliaHighlightValue;
    story_title?: AlgoliaHighlightValue;
  };
  _tags?: string[];
  author: string;
  comment_text?: string | null;
  created_at: string;
  created_at_i: number;
  num_comments?: number | null;
  objectID: string;
  points?: number | null;
  story_id?: number | null;
  story_text?: string | null;
  story_title?: string | null;
  title?: string | null;
  url?: string | null;
}
