// The lanes. This file is the thing you tune for your demo.
//
// Each lane sends the SAME recording, transformed differently. They disagree, and the
// disagreements are where Quorum earns its keep.
//
// Why audio and not vocabulary: the beta endpoint accepts keyterm and prompt fields
// but ignores them - verified on clips where the model demonstrably mishears the
// hinted term, output is byte-identical with and without. See docs/design.md 5.
//
// Measured on `ask Saoirse to check the kustomize overlay on etcd`:
//
//   raw           Ask Sirsha to check the customize overlay on it.
//   gain x2       Ask Saoirse to check the customize overlay on Ed.
//   pad 200ms     Ask Saoirse to check the customize overlay on Edged.
//   speed 0.95    Ask Saoirse to check the customize overlay on it.
//
// Three of four recover "Saoirse"; the untouched audio is the one that gets it wrong.

export const LANES = [
  {
    id: 'raw',
    name: 'Untouched',
    blurb: 'The recording as captured. The control group.',
    transform: { op: 'none' }
  },
  {
    id: 'loud',
    name: 'Amplified',
    blurb: '2x gain, clipped. Lifts quiet consonants.',
    transform: { op: 'gain', arg: 2.0 }
  },
  {
    id: 'shifted',
    name: 'Padded',
    blurb: '200ms of silence each side. Moves every word boundary.',
    transform: { op: 'pad', arg: 3200 }
  },
  {
    id: 'slowed',
    name: 'Slowed',
    blurb: '0.95x. Same words, different acoustic frames.',
    transform: { op: 'stretch', arg: 0.95 }
  }
];

// Terms the speaker is known to use. The API ignores vocabulary hints, so the MERGE
// uses these to break ties between spellings the lanes actually heard (isKnown in
// src/align.js). Put your own demo words here - names especially.
//
// Provenance matters for the eval: this list is the original lane vocabulary, written
// before the hard eval clips (07-12) existed. It deliberately does NOT contain their
// answers, so eval numbers with it are not tuned to the test set.
export const VOCABULARY = [
  'kubectl', 'Docker', 'Terraform', 'Postgres', 'Redis', 'nginx',
  'staging', 'prod', 'rollback', 'webhook', 'OAuth', 'JWT',
  'AssemblyAI', 'Supabase', 'Vercel', 'repo', 'commit', 'rebase',
  'idempotent', 'gRPC',
  'Priya', 'Reet', 'Aanya', 'Marcus', 'Yuki', 'Ines', 'Rahul',
  'Bangalore', 'Lisbon', 'Toronto', 'Nairobi'
];
