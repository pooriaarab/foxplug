import airtable from "./catalog/airtable.json" with { type: "json" };
import asana from "./catalog/asana.json" with { type: "json" };
import github from "./catalog/github.json" with { type: "json" };
import linear from "./catalog/linear.json" with { type: "json" };
import notion from "./catalog/notion.json" with { type: "json" };
import slack from "./catalog/slack.json" with { type: "json" };
import stripe from "./catalog/stripe.json" with { type: "json" };
import todoist from "./catalog/todoist.json" with { type: "json" };
import { parseManifest, type Manifest } from "./manifest.js";

/** The hand-written, tested manifests. Each one uses a key or token that the user pastes. */
export const GOLD: readonly Manifest[] = Object.freeze(
  [airtable, asana, github, linear, notion, slack, stripe, todoist].map((m) => parseManifest(m)),
);
