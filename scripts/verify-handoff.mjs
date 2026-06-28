/**
 * Quick verification for CLI → coordinator handoff extraction.
 * Run: node scripts/verify-handoff.mjs
 */

const ROLE_BLOCKS = {
  scout: { start: '---SCOUT-FINDINGS---', end: '---END-SCOUT-FINDINGS---' },
  builder: { start: '---BUILDER-REPORT---', end: '---END-BUILDER-REPORT---' },
  reviewer: { start: '---REVIEW-VERDICT---', end: '---END-REVIEW-VERDICT---' },
};

function extract(output, role) {
  const markers = ROLE_BLOCKS[role];
  if (!markers) return null;
  const startIdx = output.indexOf(markers.start);
  if (startIdx === -1) return null;
  const endIdx = output.indexOf(markers.end, startIdx + markers.start.length);
  if (endIdx === -1) return null;
  return output.slice(startIdx, endIdx + markers.end.length).trim();
}

const errors = [];

const scoutFixture = [
  'zsh prompt %',
  '---SCOUT-FINDINGS---',
  '## Relevant Files',
  '- src/services/swarm/AgentManager.ts',
  '---END-SCOUT-FINDINGS---',
  '❯',
].join('\n');

const scout = extract(scoutFixture, 'scout');
if (!scout || !scout.includes('AgentManager.ts')) {
  errors.push('scout block not extracted from CLI fixture');
}

const builderFixture = [
  'Brewed for 9s',
  '---BUILDER-REPORT---',
  '## Files Modified',
  '- src/foo.ts',
  '---END-BUILDER-REPORT---',
].join('\n');

const builder = extract(builderFixture, 'builder');
if (!builder || !builder.includes('src/foo.ts')) {
  errors.push('builder block not extracted from CLI fixture');
}

const reviewerFixture = [
  '---REVIEW-VERDICT---',
  '## Decision: REVISE',
  '## Revision Instructions',
  '- Fix tests',
  '---END-REVIEW-VERDICT---',
].join('\n');

const reviewer = extract(reviewerFixture, 'reviewer');
if (!reviewer || !reviewer.includes('REVISE')) {
  errors.push('reviewer block not extracted from CLI fixture');
}

if (errors.length > 0) {
  console.error('verify-handoff FAILED');
  for (const err of errors) console.error(' -', err);
  process.exit(1);
}

console.log('verify-handoff OK — structured CLI blocks extract correctly for coordinator handoff');
