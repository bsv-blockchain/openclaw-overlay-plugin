/**
 * Merkle path utilities for SPV proofs.
 */
// We'll import MerklePath dynamically to avoid issues with ESM resolution
let _MerklePath = null;
async function getMerklePath() {
    if (_MerklePath)
        return _MerklePath;
    const sdk = await import('@bsv/sdk');
    _MerklePath = sdk.MerklePath;
    return _MerklePath;
}
/**
 * Build a MerklePath from TSC (Transaction Status Check) proof data.
 * @param txid - Transaction ID
 * @param txIndex - Transaction's index in the block
 * @param nodes - Array of sibling hashes (or '*' for duplicate)
 * @param blockHeight - Block height
 */
export async function buildMerklePathFromTSC(txid, txIndex, nodes, blockHeight) {
    const MerklePath = await getMerklePath();
    const treeHeight = nodes.length;
    const mpPath = [];
    // Level 0
    const level0 = [
        { offset: txIndex, hash: txid, txid: true }
    ];
    if (nodes[0] === '*') {
        level0.push({ offset: txIndex ^ 1, duplicate: true });
    }
    else {
        level0.push({ offset: txIndex ^ 1, hash: nodes[0] });
    }
    level0.sort((a, b) => a.offset - b.offset);
    mpPath.push(level0);
    // Higher levels
    for (let i = 1; i < treeHeight; i++) {
        const siblingOffset = (txIndex >> i) ^ 1;
        if (nodes[i] === '*') {
            mpPath.push([{ offset: siblingOffset, duplicate: true }]);
        }
        else {
            mpPath.push([{ offset: siblingOffset, hash: nodes[i] }]);
        }
    }
    return new MerklePath(blockHeight, mpPath);
}
