export type FundingSourceKind =
  | "curated_list"
  | "structured_registry"
  | "runtime_tool"
  | "low_signal";

export type FundingSourceFit = "accepted" | "future_hook" | "rejected";

export type FundingSourceDomain =
  | "grants"
  | "investors"
  | "oss_funding"
  | "founder_launch";

export type FundingSourceAccess =
  | "none"
  | "github_token"
  | "vendor_api"
  | "separate_runtime";

export type FundingSource = {
  id: string;
  repo: string;
  name: string;
  url: string;
  domain: FundingSourceDomain;
  kind: FundingSourceKind;
  fit: FundingSourceFit;
  access: FundingSourceAccess;
  summary: string;
  useNow: string;
  reason: string;
  operatorActions: string[];
  futureHooks: string[];
};

const FUNDING_REGISTRY: FundingSource[] = [
  {
    id: "microgrants",
    repo: "nayafia/microgrants",
    name: "Microgrants",
    url: "https://github.com/nayafia/microgrants",
    domain: "grants",
    kind: "curated_list",
    fit: "accepted",
    access: "none",
    summary: "Curated microgrant list for small non-dilutive shots.",
    useNow: "Quick-scan programs and route the operator to application links.",
    reason:
      "High-signal public list, no runtime needed, and directly aligned with STARRA's funding brief.",
    operatorActions: ["Scan microgrants", "Open source repo", "Triage for fit"],
    futureHooks: [],
  },
  {
    id: "ogrants",
    repo: "weecology/ogrants",
    name: "Open Grants List",
    url: "https://github.com/weecology/ogrants",
    domain: "grants",
    kind: "structured_registry",
    fit: "accepted",
    access: "none",
    summary: "Open grants corpus with public metadata and proposals.",
    useNow: "Use as grant pattern intelligence, not as direct startup lead flow.",
    reason:
      "Real structured grant archive, but research-heavy; useful for proposal framing more than immediate founder outreach.",
    operatorActions: ["Inspect grant patterns", "Study funder language", "Mine proposal references"],
    futureHooks: [],
  },
  {
    id: "oss-funding",
    repo: "opensource-observer/oss-funding",
    name: "OSS Funding",
    url: "https://github.com/opensource-observer/oss-funding",
    domain: "oss_funding",
    kind: "structured_registry",
    fit: "accepted",
    access: "none",
    summary: "Structured registry of grants and funding events for OSS projects.",
    useNow: "Track who funds open-source infrastructure and how rounds are labeled.",
    reason:
      "Best structured dataset in the set. Useful immediately as a registry, even before deeper ingestion.",
    operatorActions: ["Review funders", "Study round naming", "Map OSS-aligned capital"],
    futureHooks: [],
  },
  {
    id: "awesome-grants",
    repo: "yueyueL/awesome-grants",
    name: "Awesome Grants",
    url: "https://github.com/yueyueL/awesome-grants",
    domain: "grants",
    kind: "curated_list",
    fit: "accepted",
    access: "none",
    summary: "Curated grant and fellowship directory across research and indie work.",
    useNow: "Use as a broad discovery surface and convert promising items into operator tasks.",
    reason:
      "Broad but lightweight. Good intake surface when treated as curated metadata, not a live database.",
    operatorActions: ["Scan broad funding lanes", "Open source repo", "Promote leads to tasks"],
    futureHooks: [],
  },
  {
    id: "devtools-angels",
    repo: "swyxio/devtools-angels",
    name: "Devtools Angels",
    url: "https://github.com/swyxio/devtools-angels",
    domain: "investors",
    kind: "curated_list",
    fit: "accepted",
    access: "none",
    summary: "Curated angel list for devtools and infrastructure founders.",
    useNow: "Use as investor discovery for tool-native STARRA adjacencies.",
    reason:
      "Static and niche, but the investor identities are concrete and immediately usable for outbound research.",
    operatorActions: ["Review investor theses", "Open source repo", "Shortlist outreach targets"],
    futureHooks: [],
  },
  {
    id: "awesome-launch-funding",
    repo: "soGeneri/awesome-launch",
    name: "Awesome Launch Funding",
    url: "https://github.com/soGeneri/awesome-launch",
    domain: "founder_launch",
    kind: "curated_list",
    fit: "accepted",
    access: "none",
    summary: "Founder-facing launch directory with funding, crowdfunding, and grant links.",
    useNow: "Use as a general-capital index for startup-friendly programs and platforms.",
    reason:
      "High-level and broad, but useful as a launchpad directory when normalized into categories.",
    operatorActions: ["Scan capital channels", "Open funding list", "Triage platform fit"],
    futureHooks: [],
  },
  {
    id: "funder-finder",
    repo: "georgetown-cset/funder-finder",
    name: "Funder Finder",
    url: "https://github.com/georgetown-cset/funder-finder",
    domain: "oss_funding",
    kind: "runtime_tool",
    fit: "future_hook",
    access: "github_token",
    summary: "Python tool that resolves funding signals for a given GitHub repository.",
    useNow: "Dormant until keys and runtime are linked.",
    reason:
      "Practical for future repo-level due diligence, but it needs GitHub credentials and separate execution.",
    operatorActions: ["Link GitHub token", "Add Open Collective key", "Run against target repos"],
    futureHooks: ["github_token", "open_collective_api_key"],
  },
  {
    id: "angel-agent",
    repo: "aiassistsecure/angel",
    name: "Angel Agent",
    url: "https://github.com/aiassistsecure/angel",
    domain: "investors",
    kind: "runtime_tool",
    fit: "future_hook",
    access: "vendor_api",
    summary: "Investor-discovery agent built on a vendor intelligence API.",
    useNow: "Not useful in-core until the external API and runtime are trusted and linked.",
    reason:
      "Interesting operator workflow, but too dependent on a third-party API and separate Python runtime for a first slice.",
    operatorActions: ["Validate vendor", "Link API key", "Sandbox separately"],
    futureHooks: ["aiassist_api_key"],
  },
  {
    id: "fund-flow-ai",
    repo: "Dessiidoo/Fund-Flow-AI",
    name: "Fund Flow AI",
    url: "https://github.com/Dessiidoo/Fund-Flow-AI",
    domain: "investors",
    kind: "low_signal",
    fit: "rejected",
    access: "separate_runtime",
    summary: "Fundraising CRM scaffold with bundled dataset claims.",
    useNow: "Do not ingest into STARGATE.",
    reason:
      "Looks more like a separate SaaS starter than a trustworthy source-of-truth dataset, and it drags in the wrong UI stack.",
    operatorActions: ["Exclude from intake"],
    futureHooks: [],
  },
];

export function getFundingRegistry(): FundingSource[] {
  return FUNDING_REGISTRY.map((source) => ({ ...source }));
}

export function summarizeFundingRegistry(sources = getFundingRegistry()) {
  const acceptedNow = sources.filter(
    (source) => source.fit === "accepted" && source.access === "none",
  );
  const futureHooks = sources.filter((source) => source.fit === "future_hook");
  const rejected = sources.filter((source) => source.fit === "rejected");

  return {
    acceptedNow,
    futureHooks,
    rejected,
    counts: {
      total: sources.length,
      acceptedNow: acceptedNow.length,
      futureHooks: futureHooks.length,
      rejected: rejected.length,
    },
  };
}
