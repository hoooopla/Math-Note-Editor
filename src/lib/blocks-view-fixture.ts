import { computeReferences } from './block-metadata';

/** Deterministic, test-only examples. Never persisted to the user's workspace. */
export function createBlocksViewFixture(size = 360) {
    const blocks: Array<{ id: string; label: string; title: string; content: string; references: string[]; hasContent: boolean }> = [];
    const add = (key: string, label: string, title: string, content = 'A mathematical observation with substantive content.') => {
        blocks.push({ id: `bv-${key}`, label, title, content, references: computeReferences(content), hasContent: !!content.trim() });
    };
    add('analysis', 'atlas/analysis', 'Analysis');
    add('foundation', 'atlas/foundations/completeness', 'Definition · Completeness of $\\mathbb{R}$', 'Every nonempty subset bounded above has a least upper bound.');
    add('uniform', 'atlas/analysis/sequences/convergence/uniform', 'Theorem · Uniform convergence of $f_n$ on compact subsets under equicontinuity and pointwise convergence', 'The hypotheses matter. [[atlas/foundations/completeness]]');
    add('empty', 'atlas/analysis/empty', 'An empty note is still a real block', '  ');
    add('self', 'atlas/logic/self', 'Observation · Self-reference', '[[atlas/logic/self]]');
    add('cycle-a', 'atlas/logic/cycle/a', 'Equivalent condition A', '[[atlas/logic/cycle/b]]');
    add('cycle-b', 'atlas/logic/cycle/b', 'Equivalent condition B', '[[atlas/logic/cycle/c]]');
    add('cycle-c', 'atlas/logic/cycle/c', 'Equivalent condition C', '[[atlas/logic/cycle/a]]');
    add('pair-a', 'atlas/algebra/equivalence/a', 'Two-way implication A', '[[atlas/algebra/equivalence/b]]');
    add('pair-b', 'atlas/algebra/equivalence/b', 'Two-way implication B', '[[atlas/algebra/equivalence/a]]');
    add('repeat', 'atlas/analysis/repeated', 'Five mentions of one definition', Array(5).fill('[[atlas/foundations/completeness]]').join('\n\n'));
    add('broken', 'atlas/analysis/broken', 'An unresolved reference', '[[atlas/missing/lemma]] [[atlas/missing/lemma]]');
    add('duplicate-a', 'atlas/conflict', 'Conflicting label · first author');
    add('duplicate-b', 'atlas/conflict', 'Conflicting label · second author');
    add('ambiguous', 'atlas/analysis/ambiguous', 'An ambiguous reference', '[[atlas/conflict]]');
    add('isolated', 'isolated-example', 'Fully isolated observation');
    add('relative', 'atlas/relative', 'Relative reference parent', '[[/child]]');
    add('relative-child', 'atlas/relative/child', 'Relative reference child');
    add('deep', `atlas/deep/${Array.from({ length: 32 }, (_, i) => `level-${i + 1}`).join('/')}/limit`, 'A note below 32 missing intermediate labels');
    add('unicode', 'atlas/幾何/連續性', '引理 · Continuity of $\\varphi : X \\to Y$');
    add('long', `atlas/long/${'a-very-long-namespace-'.repeat(8)}/convergence`, 'Lemma · ' + 'A long descriptive mathematical title with necessary assumptions and qualifications '.repeat(5));
    add('same-name', 'atlas/topology/convergence', 'Convergence');
    add('same-name-2', 'atlas/probability/convergence', 'Convergence');
    for (let i = 0; i < 25; i++) add(`chain-${i}`, `atlas/dependencies/step-${i}`, `Lemma · Dependency step ${i}`, i ? `[[atlas/dependencies/step-${i - 1}]]` : 'The starting assumption.');
    for (let i = 0; blocks.length < size; i++) {
        const label = `atlas/${i < 220 ? 'applications' : 'disconnected'}/result-${String(i).padStart(4, '0')}`;
        add(`result-${i}`, label, `Theorem ${i + 1} · Bounds for $x_{${i}}$`, i < 220 ? '[[atlas/foundations/completeness]]' : i % 7 === 0 ? '' : 'An independent observation.');
    }
    return blocks;
}
