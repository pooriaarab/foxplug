import airtable from "./catalog/airtable.json" with { type: "json" };
import asana from "./catalog/asana.json" with { type: "json" };
import github from "./catalog/github.json" with { type: "json" };
import linear from "./catalog/linear.json" with { type: "json" };
import notion from "./catalog/notion.json" with { type: "json" };
import slack from "./catalog/slack.json" with { type: "json" };
import stripe from "./catalog/stripe.json" with { type: "json" };
import todoist from "./catalog/todoist.json" with { type: "json" };
import { parseGold, type Manifest } from "./manifest.js";

/**
 * The gold actions that may be a POST read, because the API reads through POST: a
 * GraphQL query or a search. Each one was checked by hand to change no data.
 */
export const POST_READS: readonly string[] = Object.freeze(["linear.issue_list", "linear.team_list", "notion.search"]);

/** The hand-written, tested manifests. Each one uses a key or token that the user pastes. */
export const GOLD: readonly Manifest[] = Object.freeze(
  [airtable, asana, github, linear, notion, slack, stripe, todoist].map((m) => parseGold(m, POST_READS)),
);
