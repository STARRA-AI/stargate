export const meta = {
  name: 'starra-loop',
  description: "Classic's standing agentic loop: Opus/Sonnet build, Fable PM verifies, Classic has final say. Pass a task brief (string) or {brief, plan, proj} via args.",
  phases: [
    { title: 'Plan', detail: 'Opus decomposes the task into non-overlapping file ownership (skipped if a plan is passed in)' },
    { title: 'Build', detail: 'Model-assigned agents implement their partitions in parallel' },
    { title: 'Verify', detail: 'Fable PM: typecheck + contract checks' },
    { title: 'Fix', detail: 'Opus repairs any failures, Fable re-verifies' },
  ],
}

// args: a bare string brief, or { brief, plan?, proj? }.
const input = typeof args === 'string' ? { brief: args } : (args || {})
const PROJ = input.proj || '/Users/work/Projects/stargate'
const BRIEF = input.brief || 'No brief provided.'

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['contract', 'agents', 'verifyChecks'],
  properties: {
    contract: { type: 'string', description: 'The shared interface/invariant both builders must honor so parallel edits integrate.' },
    agents: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'model', 'files', 'instructions'],
        properties: {
          label: { type: 'string' },
          model: { type: 'string', enum: ['opus', 'sonnet', 'fable', 'haiku'] },
          files: { type: 'array', items: { type: 'string' }, description: 'Exact repo-relative files this agent exclusively owns. Must not overlap other agents.' },
          instructions: { type: 'string' },
        },
      },
    },
    verifyChecks: { type: 'array', items: { type: 'string' }, description: 'Concrete pass/fail checks Fable must confirm.' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pass', 'typecheckClean', 'errors', 'checks', 'notes'],
  properties: {
    pass: { type: 'boolean' },
    typecheckClean: { type: 'boolean' },
    errors: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

function verifyPrompt(plan) {
  return `You are Fable, the PROJECT MANAGER verifying this change. DO NOT edit any files. Work in ${PROJ}.
1) Run: cd ${PROJ} && npx tsc --noEmit — capture full output + exit code.
2) Run: cd ${PROJ} && npx eslint ${plan.agents.flatMap((a) => a.files).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx')).join(' ')} — report any errors.
3) Confirm each of these checks by reading the changed files:
${plan.verifyChecks.map((c, i) => `   ${i + 1}. ${c}`).join('\n')}
Also confirm the shared contract held: ${plan.contract}
Report pass=true ONLY IF typecheck exits 0 AND every check holds. Put each failed/unverifiable check (with exact error lines) in errors[]; put each passed check in checks[]. Be terse and precise.`
}

// ---- Plan (skip if caller passed one) --------------------------------
let plan = input.plan
if (!plan) {
  phase('Plan')
  plan = await agent(
    `You are the planning lead (Opus) for Classic's STARGATE deck at ${PROJ} (Next.js/TypeScript/React).
TASK: ${BRIEF}
Explore the relevant code, then produce an implementation plan. Partition the work into non-overlapping file ownership — each agent owns an exclusive set of files so parallel edits never conflict. Assign 'opus' to the hardest/core logic and 'sonnet' to UI/supporting work. Define a shared contract (any interface both must honor) and concrete verify checks. Keep it to 2-3 build agents.`,
    { label: 'opus:plan', phase: 'Plan', model: 'opus', effort: 'high', agentType: 'general-purpose', schema: PLAN_SCHEMA },
  )
}

if (!plan || !Array.isArray(plan.agents) || plan.agents.length === 0) {
  return { error: 'No usable plan', plan }
}

// ---- Build (parallel, non-overlapping files) -------------------------
phase('Build')
const built = await parallel(
  plan.agents.map((a) => () =>
    agent(
      `${a.instructions}

YOU OWN ONLY THESE FILES — do NOT touch any other file: ${a.files.join(', ')}
SHARED CONTRACT (honor exactly): ${plan.contract}
Work in ${PROJ}. After editing, run \`cd ${PROJ} && npx tsc --noEmit\` and fix any errors IN YOUR FILES ONLY. Do not run the dev server. Report exactly what you changed.`,
      { label: a.label, phase: 'Build', model: a.model, agentType: 'general-purpose' },
    ),
  ),
)

// ---- Verify (Fable PM) -----------------------------------------------
phase('Verify')
let verify = await agent(verifyPrompt(plan), {
  label: 'fable:verify', phase: 'Verify', model: 'fable', agentType: 'general-purpose', schema: VERIFY_SCHEMA,
})

// ---- Fix round if needed ---------------------------------------------
if (verify && !verify.pass) {
  phase('Fix')
  await agent(
    `You are the repair builder (Opus). This change failed verification. Work in ${PROJ}.
Fix ONLY what's needed to make \`npx tsc --noEmit\` pass AND satisfy the contract, honoring the same file-ownership boundaries.
SHARED CONTRACT: ${plan.contract}
FAILURES:
${JSON.stringify(verify.errors, null, 2)}
After fixing, run \`cd ${PROJ} && npx tsc --noEmit\` and confirm exit 0. Report the fixes.`,
    { label: 'opus:fix', phase: 'Fix', model: 'opus', agentType: 'general-purpose' },
  )
  verify = await agent(verifyPrompt(plan), {
    label: 'fable:reverify', phase: 'Fix', model: 'fable', agentType: 'general-purpose', schema: VERIFY_SCHEMA,
  })
}

return { plan, built, verify }
