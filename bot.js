require('dotenv').config();
const { 
    Connection, PublicKey, Keypair, Transaction, SystemProgram, 
    sendAndConfirmTransaction, LAMPORTS_PER_SOL 
} = require('@solana/web3.js');
const axios = require('axios');
const bs58 = require('bs58');
const express = require('express');
const cors = require('cors');

// --- CONFIGURAÇÃO ---
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${(process.env.HELIUS_API_KEY || "").trim()}`;
const connection = new Connection(HELIUS_RPC, 'confirmed');

const decodeBase58 = (typeof bs58.decode === 'function') ? bs58.decode : bs58.default.decode;
const DEV_KEYPAIR = Keypair.fromSecretKey(decodeBase58(process.env.DEV_PRIVATE_KEY.trim()));
const MINT_ADDRESS = new PublicKey(process.env.TOKEN_MINT.trim());
const TEAM_WALLET = new PublicKey(process.env.TEAM_WALLET.trim());

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutos

// --- ESTADO GLOBAL (O que o Frontend vai ler) ---
let lotteryState = {
    tokenSymbol: '',
    tokenAdress: 'TOKEN_MINT',
    marketCap: 0,
    nextDraw: new Date(Date.now() + INTERVAL_MS).toISOString(),
    lastScenario: "A",
    lastWinners: [],
    buybackTotal: 0, // Acumulado de buybacks (exemplo)
    poolSol: 0
};

/**
 * FETCH MARKET CAP & TOKEN INFO (DexScreener)
 */
async function updateMarketCap() {
    try {
        const url = `https://api.dexscreener.com/latest/dex/tokens/${MINT_ADDRESS.toBase58()}`;
        const res = await axios.get(url);
        if (res.data.pairs && res.data.pairs.length > 0) {
            const pair = res.data.pairs[0];
            
            // Atualiza os dados no estado global
            lotteryState.marketCap = parseFloat(pair.fdv || 0);
            lotteryState.tokenSymbol = pair.baseToken.symbol; 
            
            console.log(`[DATA] Token: ${pair.baseToken.symbol} | MC: $${lotteryState.marketCap}`);
        }
    } catch (err) {
        console.error("[ERROR] DexScreener API failed:", err.message);
    }
}

/**
 * FETCH ALL HOLDERS
 */
async function getAllHolders() {
    console.log("[INFO] Fetching token holders...");
    try {
        const accounts = await connection.getProgramAccounts(
            new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
            {
                filters: [
                    { dataSize: 165 },
                    { memcmp: { offset: 0, bytes: MINT_ADDRESS.toBase58() } }
                ]
            }
        );
        // Extrai as PublicKeys dos donos das contas
        return accounts.map(a => {
            const data = Buffer.from(a.account.data);
            return new PublicKey(data.slice(32, 64));
        });
    } catch (err) {
        console.error("[ERROR] Failed to fetch holders:", err.message);
        return [];
    }
}

/**
 * JUPITER BUYBACK (SIMULAÇÃO)
 */
async function executeBuyback(solAmount) {
    const amountInSol = solAmount / LAMPORTS_PER_SOL;
    console.log(`[ACTION] Buyback de ${amountInSol} SOL iniciado...`);
    lotteryState.buybackTotal += amountInSol;
    return true;
}

/**
 * SEND SOL
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
        return true;
    } catch (err) {
        console.error(`[ERROR] Payout failed for ${toPubkey.toBase58()}`);
        return false;
    }
}

/**
 * CICLO PRINCIPAL DA LOTERIA
 */
async function runLotteryCycle() {
    console.log(`\n--- INICIANDO CICLO: ${new Date().toISOString()} ---`);
    
    try {
        await updateMarketCap();
        const balance = await connection.getBalance(DEV_KEYPAIR.publicKey);
        lotteryState.poolSol = balance / LAMPORTS_PER_SOL;

        // Se o saldo for muito baixo, apenas atualizamos o timer e pulamos
        if (balance < 0.01 * LAMPORTS_PER_SOL) {
            console.log("[SKIP] Saldo insuficiente para distribuição.");
            lotteryState.nextDraw = new Date(Date.now() + INTERVAL_MS).toISOString();
            return;
        }

        const feesToDistribute = balance * 0.9; // Deixa 10% para taxas de rede
        const roll = Math.floor(Math.random() * 100) + 1;
        const holders = await getAllHolders();
        let winnersThisCycle = [];

        if (roll <= 80) {
            // CENÁRIO A: 80% (50% Buyback / 50% para 3 Holders)
            lotteryState.lastScenario = "A";
            const prizePool = feesToDistribute * 0.5;
            await executeBuyback(prizePool);
            
            const shuffled = holders.sort(() => 0.5 - Math.random());
            const luckyThree = shuffled.slice(0, 3);
            const prizePerWinner = prizePool / 3;

            for (const winner of luckyThree) {
                const success = await sendSOL(winner, prizePerWinner);
                if (success) {
                    winnersThisCycle.push({ 
                        address: winner.toBase58(), 
                        amount: prizePerWinner / LAMPORTS_PER_SOL, 
                        type: "SOL" 
                    });
                }
            }

        } else if (roll <= 90) {
            // CENÁRIO B: 10% (JACKPOT - 100% para 1 Holder)
            lotteryState.lastScenario = "B";
            const luckyWinner = holders[Math.floor(Math.random() * holders.length)];
            const success = await sendSOL(luckyWinner, feesToDistribute);
            if (success) {
                winnersThisCycle.push({ 
                    address: luckyWinner.toBase58(), 
                    amount: feesToDistribute / LAMPORTS_PER_SOL, 
                    type: "SOL" 
                });
            }

        } else {
            // CENÁRIO C: 10% (Manutenção - Team Wallet)
            lotteryState.lastScenario = "C";
            await sendSOL(TEAM_WALLET, feesToDistribute);
            winnersThisCycle.push({ 
                address: "TEAM_WALLET", 
                amount: feesToDistribute / LAMPORTS_PER_SOL, 
                type: "SOL" 
            });
        }

        // Atualiza o estado para o Lovable ler
        lotteryState.lastWinners = winnersThisCycle;
        lotteryState.nextDraw = new Date(Date.now() + INTERVAL_MS).toISOString();

    } catch (err) {
        console.error("[CRITICAL] Erro no ciclo:", err);
    }
    console.log(`--- FIM DO CICLO. Próximo em: ${lotteryState.nextDraw} ---`);
}

// --- SERVIDOR EXPRESS PARA O LOVABLE ---
const app = express();
app.use(cors());
app.use(express.json());

// Rota principal que o Lovable vai chamar
app.get('/api/lottery', (req, res) => {
    res.json(lotteryState);
});

// Health check
app.get('/', (req, res) => res.send("Lottery Bot Online"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API da Loteria rodando na porta ${PORT}`);
});

// Inicialização
setInterval(runLotteryCycle, INTERVAL_MS);
runLotteryCycle(); // Executa o primeiro imediatamente