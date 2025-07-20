import { flashBorrowReserveLiquidityInstruction, flashRepayReserveLiquidityInstruction } from '@solendprotocol/solend-sdk';
import BN from 'bn.js';
import bs58 from 'bs58';
import axios from 'axios';
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram, SendTransactionError, TransactionInstruction, AddressLookupTableAccount } from '@solana/web3.js';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID, createSyncNativeInstruction } from '@solana/spl-token';

// Hardcoded RPC URL
const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=62802680-f5c5-4418-b266-43eb2c694dbe';

// Initialize connection
const connection = new Connection(RPC_URL, {
    commitment: 'confirmed',
});

// Load wallet with hardcoded dummy private key
let wallet: Keypair;
try {
    const privateKey = '4G2wvwpPC8KD7QH9uZ8B5ox65LZDyW8hGJyP9BympjnAB9vwHTZdtcJrzN75SKBaG9AViR6LFm1ZTuHT7ZR4ZrA5';
    wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    if (wallet.publicKey.toBase58() !== 'BF6k4eocw6naX3bpEM1czVX3e2bWV6BXjNQ1MuTyup8H') {
        throw new Error('Private key does not match expected public key BF6k4eocw6naX3bpEM1czVX3e2bWV6BXjNQ1MuTyup8H');
    }
    console.log('Wallet loaded:', wallet.publicKey.toBase58());
} catch (error) {
    console.error('Failed to load private key:', error);
    process.exit(1);
}

// Flashloan parameters (1 SOL = 1,000,000,000 lamports)
const liquidityAmount = new BN(1000000000);
const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDT_MINT = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
const FLASHLOAN_FEE = 5; // 5bps (0.05%)
const FEE_FUND_AMOUNT = new BN(1000000); // 0.001 SOL to cover fee and buffer

// Solend-specific addresses (mainnet, may need verification post-rebrand)
const lendingMarket = new PublicKey('4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY');
const sourceLiquidity = new PublicKey('8UviNr47S8eL6J3WfDxMRa3hvLta1VDJwNWqsDgtN3Cv');
const lendingProgramId = new PublicKey('So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo');
const reserve = new PublicKey('8PbodeaosQP19SjYFx855UMqWxH2HynZLdBXmsrbac36');
const reserveLiquidityFeeReceiver = new PublicKey('5wo1tFpi4HaVKnemqaXeQnBEpezrJXcXvuztYaPhvgC7');

// Jupiter swap functions from reference script
async function getJupiterQuote(inputMint: PublicKey, outputMint: PublicKey, amount: BN) {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount.toString()}&slippageBps=50&onlyDirectRoutes=true`;
    try {
        const response = await axios.get(url, { headers: { 'Accept': 'application/json' }});
        return response.data;
    } catch (error: any) {
        console.error(`Jupiter quote failed:`, error.response?.data?.error || error.message);
        return null;
    }
}

async function getJupiterSwapInfo(quoteResponse: any, userPublicKey: PublicKey, connection: Connection): Promise<{ instructions: TransactionInstruction[], addressTableLookups: AddressLookupTableAccount[] } | null> {
    const url = 'https://quote-api.jup.ag/v6/swap';
    try {
        const payload = {
            quoteResponse,
            userPublicKey: userPublicKey.toString(),
            wrapAndUnwrapSol: false,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 75000
        };

        const { data } = await axios.post(url, payload);
        const { swapTransaction } = data;
        const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        const message = transaction.message;

        const addressTableLookups = await Promise.all(
            message.addressTableLookups.map(async (lookup) => {
                const accountInfo = await connection.getAccountInfo(lookup.accountKey);
                if (!accountInfo) throw new Error(`Failed to fetch LUT: ${lookup.accountKey.toBase58()}`);
                return new AddressLookupTableAccount({ key: lookup.accountKey, state: AddressLookupTableAccount.deserialize(accountInfo.data) });
            })
        );

        const accountKeys = message.getAccountKeys({
            addressLookupTableAccounts: addressTableLookups,
        });

        const instructions = message.compiledInstructions.map(compiledIx => new TransactionInstruction({
            programId: accountKeys.get(compiledIx.programIdIndex)!,
            keys: compiledIx.accountKeyIndexes.map(index => ({
                pubkey: accountKeys.get(index)!,
                isSigner: message.isAccountSigner(index),
                isWritable: message.isAccountWritable(index),
            })),
            data: Buffer.from(compiledIx.data),
        }));

        return { instructions, addressTableLookups };
    } catch (error: any) {
        console.error(`Jupiter swap info failed:`, error.message);
        return null;
    }
}

// USDT ATA function
async function getOrCreateUSDTATA(): Promise<PublicKey> {
    const tokenAccount = await getAssociatedTokenAddress(
        USDT_MINT,
        wallet.publicKey,
        false,
        TOKEN_PROGRAM_ID
    );
    
    const accountInfo = await connection.getAccountInfo(tokenAccount);
    if (accountInfo) {
        return tokenAccount;
    }

    const { blockhash } = await connection.getLatestBlockhash('finalized');
    const instructions = [
        createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            tokenAccount,
            wallet.publicKey,
            USDT_MINT,
            TOKEN_PROGRAM_ID
        )
    ];

    const message = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);
    transaction.sign([wallet]);

    await connection.sendTransaction(transaction, {
        skipPreflight: true,
        maxRetries: 3,
        preflightCommitment: 'confirmed',
    });

    return tokenAccount;
}

async function getOrCreateATA(): Promise<PublicKey> {
    try {
        // Get expected ATA address
        const tokenAccount = await getAssociatedTokenAddress(
            SOL_MINT,
            wallet.publicKey,
            false,
            TOKEN_PROGRAM_ID
        );
        console.log('Checking for SOL ATA:', tokenAccount.toBase58());

        // Check if ATA exists
        const accountInfo = await connection.getAccountInfo(tokenAccount);
        if (accountInfo) {
            console.log('Existing SOL ATA found:', tokenAccount.toBase58());
            return tokenAccount;
        }

        console.log('No SOL ATA found, creating one...');
        const instructions = [
            createAssociatedTokenAccountInstruction(
                wallet.publicKey, // Payer
                tokenAccount, // ATA address
                wallet.publicKey, // Owner
                SOL_MINT, // Mint
                TOKEN_PROGRAM_ID
            )
        ];

        const { blockhash } = await connection.getLatestBlockhash('finalized');
        const message = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions
        }).compileToV0Message();

        const transaction = new VersionedTransaction(message);
        transaction.sign([wallet]);

        const signature = await connection.sendTransaction(transaction, {
            skipPreflight: true,
            maxRetries: 3,
            preflightCommitment: 'confirmed',
        });

        console.log('⏳ Creating ATA, waiting for confirmation...');
        await connection.confirmTransaction(signature, 'confirmed');
        console.log('ATA created:', `https://solscan.io/account/${tokenAccount.toBase58()}`);

        return tokenAccount;
    } catch (error) {
        console.error('Failed to get or create ATA:', error);
        throw error;
    }
}

async function flashLoan(tokenAccount: PublicKey) {
    try {
        // Create USDT ATA
        const usdtAccount = await getOrCreateUSDTATA();
        console.log('USDT ATA:', usdtAccount.toBase58());

        // Get Jupiter quotes for arbitrage
        console.log('Fetching Jupiter quotes for arbitrage...');
        const solToUsdtQuote = await getJupiterQuote(SOL_MINT, USDT_MINT, liquidityAmount);
        if (!solToUsdtQuote) throw new Error("Could not get SOL -> USDT quote");
        
        const usdtAmountOut = new BN(solToUsdtQuote.outAmount);
        const usdtToSolQuote = await getJupiterQuote(USDT_MINT, SOL_MINT, usdtAmountOut);
        if (!usdtToSolQuote) throw new Error("Could not get USDT -> SOL quote");
        
        console.log('Fetching swap instructions...');
        const swapInfo1 = await getJupiterSwapInfo(solToUsdtQuote, wallet.publicKey, connection);
        if (!swapInfo1) throw new Error("Could not get SOL -> USDT swap instructions");
        
        const swapInfo2 = await getJupiterSwapInfo(usdtToSolQuote, wallet.publicKey, connection);
        if (!swapInfo2) throw new Error("Could not get USDT -> SOL swap instructions");

        // Set compute unit price for priority
        const computeUnitPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000000 });
        
        // Create flash borrow instruction
        const flashBorrow = flashBorrowReserveLiquidityInstruction(
            liquidityAmount,
            sourceLiquidity,
            tokenAccount,
            reserve,
            lendingMarket,
            lendingProgramId
        );

        // Create flash repay instruction - Fixed the duplicate tokenAccount parameter
        const flashRepay = flashRepayReserveLiquidityInstruction(
            liquidityAmount,
            FLASHLOAN_FEE,
            tokenAccount,
            sourceLiquidity,
            reserveLiquidityFeeReceiver,
            wallet.publicKey, // Changed from tokenAccount to wallet.publicKey
            reserve,
            lendingMarket,
            wallet.publicKey,
            lendingProgramId
        );

        // Filter out duplicate compute budget instructions from Jupiter swaps
        const filteredSwap1Instructions = swapInfo1.instructions.filter(
            ix => !ix.programId.equals(ComputeBudgetProgram.programId)
        );
        const filteredSwap2Instructions = swapInfo2.instructions.filter(
            ix => !ix.programId.equals(ComputeBudgetProgram.programId)
        );

        // Combine all instructions
        const instructions = [
            computeUnitPrice,
            flashBorrow,
            ...filteredSwap1Instructions,
            ...filteredSwap2Instructions,
            flashRepay
        ];

        // Combine address lookup tables
        const uniqueLuts = new Map<string, AddressLookupTableAccount>();
        [...swapInfo1.addressTableLookups, ...swapInfo2.addressTableLookups].forEach(lut => {
            uniqueLuts.set(lut.key.toBase58(), lut);
        });
        const combinedLuts = Array.from(uniqueLuts.values());

        const { blockhash } = await connection.getLatestBlockhash('finalized');
        const message = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions
        }).compileToV0Message(combinedLuts);

        const tx = new VersionedTransaction(message);
        tx.sign([wallet]);

        // Simulate transaction
        console.log('Simulating transaction...');
        const simulation = await connection.simulateTransaction(tx, { sigVerify: false });
        console.log('Simulation result:', JSON.stringify(simulation.value, null, 2));

        if (simulation.value.err) {
            throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)} - Logs: ${simulation.value.logs?.join('\n')}`);
        }

        // Send transaction
        console.log('Sending transaction...');
        const signature = await connection.sendTransaction(tx, {
            skipPreflight: true,
            maxRetries: 3,
            preflightCommitment: 'confirmed',
        });

        console.log('⏳ Waiting for confirmation...');
        const confirmation = await connection.confirmTransaction(signature, 'confirmed');
        console.log('Transaction confirmed:', `https://solscan.io/tx/${signature}`);

        return signature;
    } catch (error: unknown) {
        console.error('Error in flashLoan:', {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            logs: error instanceof SendTransactionError ? error.logs : undefined,
        });
        throw error;
    }
}

// Execute flashloan
async function main() {
    try {
        console.log('Starting flashloan with Save.Finance (Solend) protocol...');
        const tokenAccount = await getOrCreateATA();
        const signature = await flashLoan(tokenAccount);
        console.log('Flashloan completed:', signature);
        process.exit(0);
    } catch (error) {
        console.error('Flashloan failed:', error);
        process.exit(1);
    }
}

main();