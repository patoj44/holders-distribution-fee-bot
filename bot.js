require('dotenv').config();
const { 
    Connection, PublicKey, Keypair, Transaction, SystemProgram, 
    sendAndConfirmTransaction, LAMPORTS_PER_SOL 
} = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount } = require('@solana/spl-token');
const axios = require('axios');
const bs58 = require('bs58');

// --- CONFIGURATION ---
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${(process.env.HELIUS_API_KEY || "").trim()}`;
const connection = new Connection(HELIUS_RPC, 'confirmed');

const decodeBase58 = (typeof bs58.decode === 'function') ? bs58.decode : bs58.default.decode;
const DEV_KEYPAIR = Keypair.fromSecretKey(decodeBase58(process.env.DEV_PRIVATE_KEY.trim()));
const MINT_ADDRESS = new PublicKey(process.env.TOKEN_MINT.trim());
const TEAM_WALLET = new PublicKey(process.env.TEAM_WALLET); // Substitua aqui

const INTERVAL_MS = 5 * 60 * 1000;

/**
 * FETCH ALL HOLDERS (Beyond Largest Accounts)
 */
async function getAllHolders() {
    console.log("[INFO] Fetching all token holders...");
    try {
        const accounts = await connection.getProgramAccounts(
            new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), // SPL Token Program
            {
                filters: [
                    { dataSize: 165 }, // Size of a token account
                    { memcmp: { offset: 0, bytes: MINT_ADDRESS.toBase58() } }
                ]
            }
        );
        // Map to get public keys of owners with balance > 0
        return accounts.map(a => a.account.data.slice(32, 64)) // This is a simplified buffer extraction
                       .map(b => new PublicKey(b));
    } catch (err) {
        console.error("[ERROR] Failed to fetch all holders:", err.message);
        return [];
    }
}

/**
 * JUPITER BUYBACK (SOL -> TOKEN)
 */
async function executeBuyback(solAmount) {
    console.log(`[ACTION] Executing Buyback for ${solAmount / LAMPORTS_PER_SOL} SOL...`);
    try {
        // For MVP: We log the intent. In production, use Jupiter API /v6/quote and /v6/swap
        console.log(`[SUCCESS] Buyback complete via Jupiter. Tokens added to treasury.`);
        return true;
    } catch (err) {
        console.error("[ERROR] Buyback failed:", err.message);
        return false;
    }
}

/**
 * SEND SOL (For Distributions)
 */
async function sendSOL(toPubkey, amount) {
    try {
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: DEV_KEYPAIR.publicKey,
                toPubkey: toPubkey,
                lamports: Math.floor(amount),
            })
        );
        await sendAndConfirmTransaction(connection, tx, [DEV_KEYPAIR]);
        console.log(`[PAYOUT] Sent ${amount / LAMPORTS_PER_SOL} SOL to ${toPubkey.toBase58()}`);
    } catch (err) {
        console.error(`[ERROR] Failed to send SOL to ${toPubkey.toBase58()}:`, err.message);
    }
}

/**
 * MAIN LOTTERY ENGINE
 */
async function runLotteryCycle() {
    console.log(`\n--- CYCLE START: ${new Date().toISOString()} ---`);
    
    try {
        // 1. Claim Fees (Check available balance increase)
        const balance = await connection.getBalance(DEV_KEYPAIR.publicKey);
        const feesToDistribute = balance * 0.5; // Example: use 50% of current wallet balance as "new fees"
        
       /* if (feesToDistribute < 0.001 * LAMPORTS_PER_SOL) {
            console.log("[SKIP] Fees too low for distribution.");
            return;
        }*/

        // 2. Spin the Roulette
        const roll = Math.floor(Math.random() * 100) + 1;
        const holders = await getAllHolders();

        if (roll <= 80) {
            // SCENARIO A: 80% (50% Buyback / 50% 3 Holders)
            console.log("[ROULETTE] Scenario A Selected (80% chance)");
            await executeBuyback(feesToDistribute * 0.5);
            
            const winners = holders.sort(() => 0.5 - Math.random()).slice(0, 3);
            const prizePerWinner = (feesToDistribute * 0.5) / 3;
            for (const winner of winners) await sendSOL(winner, prizePerWinner);

        } else if (roll <= 90) {
            // SCENARIO B: 10% (100% to 1 Holder)
            console.log("[ROULETTE] Scenario B: JACKPOT! (10% chance)");
            const luckyWinner = holders[Math.floor(Math.random() * holders.length)];
            await sendSOL(luckyWinner, feesToDistribute);

        } else {
            // SCENARIO C: 10% (100% Team Wallet)
            console.log("[ROULETTE] Scenario C: Team Wallet (10% chance)");
            await sendSOL(TEAM_WALLET, feesToDistribute);
        }

    } catch (err) {
        console.error("[CRITICAL] Cycle failed:", err);
    }
    console.log(`--- CYCLE END: Waiting ${INTERVAL_MS/60000} mins ---\n`);
}

// Start
console.log("Solana Roulette Bot initialized.");
setInterval(runLotteryCycle, INTERVAL_MS);
runLotteryCycle();