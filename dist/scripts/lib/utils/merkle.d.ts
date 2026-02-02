/**
 * Merkle path utilities for SPV proofs.
 */
import type { MerklePath as MerklePathType } from '@bsv/sdk';
/**
 * Build a MerklePath from TSC (Transaction Status Check) proof data.
 * @param txid - Transaction ID
 * @param txIndex - Transaction's index in the block
 * @param nodes - Array of sibling hashes (or '*' for duplicate)
 * @param blockHeight - Block height
 */
export declare function buildMerklePathFromTSC(txid: string, txIndex: number, nodes: string[], blockHeight: number): Promise<MerklePathType>;
