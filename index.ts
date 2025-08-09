import express, { Request, Response } from 'express';
import cors from 'cors';
import { EnokiClient } from '@mysten/enoki';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// DLMM Contract addresses - replace with your actual deployed addresses
const DLMM_CONFIG = {
    PACKAGE_ID: process.env.DLMM_PACKAGE_ID || "0x6a01a88c704d76ef8b0d4db811dff4dd13104a35e7a125131fa35949d0bc2ada",
    FACTORY_ID: process.env.DLMM_FACTORY_ID || "0x160e34d10029993bccf6853bb5a5140bcac1794b7c2faccc060fb3d5b7167d7f",
    ALLOWED_MODULES: [
        'position',
        'position_manager'
    ],
    ALLOWED_FUNCTIONS: [
        'create_position',
        'create_position_simple',
        'add_liquidity_to_position'
    ]
};

// Interfaces for DLMM position sponsorship
interface SponsorPositionRequest {
    transactionKindBytes: string;
    sender: string;
    poolId: string;
    tokenA: string;
    tokenB: string;
    positionValueUSD?: number;
    userEmail?: string;
    network?: 'testnet' | 'mainnet' | 'devnet';
}

interface UserSponsorshipLimits {
    dailyPositions: number;
    monthlyPositions: number;
    totalSponsorshipValueUSD: number;
}

// Simple in-memory store (use database in production)
const userSponsorshipTracking = new Map<string, {
    lastReset: Date;
    dailyCount: number;
    monthlyCount: number;
    totalValueSponsored: number;
}>();

// Initialize Enoki client
if (!process.env.ENOKI_PRIVATE_KEY) {
    throw new Error('ENOKI_PRIVATE_KEY environment variable is not set');
}

const enokiClient = new EnokiClient({
    apiKey: process.env.ENOKI_PRIVATE_KEY,
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
    res.json({ 
        status: 'ok', 
        message: 'DLMM Enoki sponsor service is running',
        dlmmConfig: {
            packageId: DLMM_CONFIG.PACKAGE_ID,
            factoryId: DLMM_CONFIG.FACTORY_ID
        }
    });
});

// DLMM Position Creation Sponsorship endpoint
app.post('/api/sponsor-position', async (req: Request<object, object, SponsorPositionRequest>, res: Response) => {
    try {
        const { 
            transactionKindBytes, 
            sender, 
            poolId, 
            tokenA, 
            tokenB, 
            positionValueUSD = 0,
            userEmail,
            network = 'testnet' 
        } = req.body;

        console.log(`📊 Position sponsorship request for ${sender}`);
        console.log(`   Pool: ${poolId}`);
        console.log(`   Tokens: ${tokenA} / ${tokenB}`);
        console.log(`   Value: $${positionValueUSD}`);

        // Validation
        if (!transactionKindBytes || !sender || !poolId || !tokenA || !tokenB) {
            return res.status(400).json({ 
                error: 'Missing required fields: transactionKindBytes, sender, poolId, tokenA, tokenB' 
            });
        }

        // Check if user is eligible for sponsorship
        const sponsorshipCheck = await checkSponsorshipEligibility(sender, positionValueUSD);
        if (!sponsorshipCheck.eligible) {
            return res.status(403).json({
                error: 'Not eligible for sponsorship',
                reason: sponsorshipCheck.reason,
                limits: sponsorshipCheck.currentLimits
            });
        }

        // Validate this is a legitimate DLMM position transaction
        const validationResult = validateDLMMTransaction(transactionKindBytes, poolId, tokenA, tokenB);
        if (!validationResult.valid) {
            return res.status(400).json({
                error: 'Invalid DLMM transaction',
                reason: validationResult.reason
            });
        }

        // Build allowed move call targets for DLMM position creation
        const allowedMoveCallTargets = [
            `${DLMM_CONFIG.PACKAGE_ID}::position::create_position`,
            `${DLMM_CONFIG.PACKAGE_ID}::position_manager::create_position_simple`,
        ];

        console.log(`✅ Sponsoring position creation for ${sender}`);

        // Create sponsored transaction
        const sponsored = await enokiClient.createSponsoredTransaction({
            network,
            transactionKindBytes,
            sender,
            allowedMoveCallTargets,
            allowedAddresses: [sender],
        });

        // Track sponsorship usage
        await trackSponsorshipUsage(sender, positionValueUSD, 'position_creation');

        // Log successful sponsorship
        console.log(`💰 Position sponsored successfully!`);
        console.log(`   Digest: ${sponsored.digest}`);
        console.log(`   Gas sponsored for user: ${sender}`);

        res.json({
            success: true,
            bytes: sponsored.bytes,
            digest: sponsored.digest,
            message: 'Position creation sponsored successfully',
            sponsorshipInfo: {
                gasFeeCovered: true,
                estimatedSavings: '$0.05-0.10',
                remainingLimits: await getRemainingLimits(sender)
            }
        });

    } catch (error) {
        console.error('❌ Error sponsoring position:', error);
        res.status(500).json({ 
            error: 'Failed to sponsor position creation',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

// Execute sponsored position transaction
app.post('/api/execute-position', async (req: Request, res: Response) => {
    try {
        const { digest, signature } = req.body;

        if (!digest || !signature) {
            return res.status(400).json({ 
                error: 'Missing required fields: digest, signature' 
            });
        }

        console.log(`🚀 Executing sponsored position creation: ${digest}`);

        const result = await enokiClient.executeSponsoredTransaction({
            digest,
            signature,
        });

        console.log(`✅ Position created successfully!`);
        console.log(`   Transaction result:`, result);

        res.json({
            success: true,
            result,
            message: 'Position created successfully with sponsored gas'
        });

    } catch (error) {
        console.error('❌ Error executing sponsored position:', error);
        res.status(500).json({ 
            error: 'Failed to execute sponsored position creation',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

// Check user sponsorship eligibility
async function checkSponsorshipEligibility(userAddress: string, positionValueUSD: number): Promise<{
    eligible: boolean;
    reason?: string;
    currentLimits?: UserSponsorshipLimits;
}> {
    const now = new Date();
    const userTracking = userSponsorshipTracking.get(userAddress);

    // New user - always eligible for first position
    if (!userTracking) {
        return { eligible: true };
    }

    // Reset daily counter if it's a new day
    if (now.getDate() !== userTracking.lastReset.getDate()) {
        userTracking.dailyCount = 0;
        userTracking.lastReset = now;
    }

    // Reset monthly counter if it's a new month
    if (now.getMonth() !== userTracking.lastReset.getMonth()) {
        userTracking.monthlyCount = 0;
    }

    // Check limits
    const limits: UserSponsorshipLimits = {
        dailyPositions: 3,      // Max 3 sponsored positions per day
        monthlyPositions: 10,   // Max 10 sponsored positions per month
        totalSponsorshipValueUSD: 50 // Max $50 worth of gas sponsored
    };

    if (userTracking.dailyCount >= limits.dailyPositions) {
        return {
            eligible: false,
            reason: 'Daily sponsorship limit reached',
            currentLimits: limits
        };
    }

    if (userTracking.monthlyCount >= limits.monthlyPositions) {
        return {
            eligible: false,
            reason: 'Monthly sponsorship limit reached',
            currentLimits: limits
        };
    }

    // Special eligibility for valuable positions
    if (positionValueUSD > 100) {
        return { eligible: true }; // Always sponsor positions > $100
    }

    return { eligible: true };
}

// Validate this is a legitimate DLMM transaction
function validateDLMMTransaction(
    transactionKindBytes: string, 
    poolId: string, 
    tokenA: string, 
    tokenB: string
): { valid: boolean; reason?: string } {
    
    // Basic validation
    if (!poolId.startsWith('0x')) {
        return { valid: false, reason: 'Invalid pool ID format' };
    }

    if (!tokenA.includes('::') || !tokenB.includes('::')) {
        return { valid: false, reason: 'Invalid token type format' };
    }

    // In production, you'd decode transactionKindBytes and validate:
    // 1. It's calling your DLMM contracts
    // 2. The pool ID matches
    // 3. The token types are correct
    // 4. No malicious operations
    
    // For now, basic checks
    if (tokenA === tokenB) {
        return { valid: false, reason: 'Token A and Token B cannot be the same' };
    }

    return { valid: true };
}

// Track sponsorship usage
async function trackSponsorshipUsage(userAddress: string, positionValueUSD: number, operation: string) {
    const now = new Date();
    const estimatedGasCost = 0.08; // ~$0.08 per position creation
    
    let userTracking = userSponsorshipTracking.get(userAddress);
    
    if (!userTracking) {
        userTracking = {
            lastReset: now,
            dailyCount: 0,
            monthlyCount: 0,
            totalValueSponsored: 0
        };
    }

    userTracking.dailyCount += 1;
    userTracking.monthlyCount += 1;
    userTracking.totalValueSponsored += estimatedGasCost;
    
    userSponsorshipTracking.set(userAddress, userTracking);

    // Log for analytics
    console.log(`📈 Sponsorship tracked for ${userAddress}:`);
    console.log(`   Operation: ${operation}`);
    console.log(`   Position value: $${positionValueUSD}`);
    console.log(`   Gas cost sponsored: $${estimatedGasCost}`);
    console.log(`   Daily count: ${userTracking.dailyCount}`);
    console.log(`   Monthly count: ${userTracking.monthlyCount}`);
}

// Get remaining sponsorship limits for user
async function getRemainingLimits(userAddress: string): Promise<UserSponsorshipLimits> {
    const userTracking = userSponsorshipTracking.get(userAddress);
    
    if (!userTracking) {
        return {
            dailyPositions: 3,
            monthlyPositions: 10,
            totalSponsorshipValueUSD: 50
        };
    }

    return {
        dailyPositions: Math.max(0, 3 - userTracking.dailyCount),
        monthlyPositions: Math.max(0, 10 - userTracking.monthlyCount),
        totalSponsorshipValueUSD: Math.max(0, 50 - userTracking.totalValueSponsored)
    };
}

// Get sponsorship analytics endpoint
app.get('/api/sponsorship-stats', (req: Request, res: Response) => {
    const totalUsers = userSponsorshipTracking.size;
    let totalSponsored = 0;
    let totalPositions = 0;

    for (const [userAddress, tracking] of userSponsorshipTracking.entries()) {
        totalSponsored += tracking.totalValueSponsored;
        totalPositions += tracking.monthlyCount;
    }

    res.json({
        analytics: {
            totalUsers,
            totalPositionsSponsored: totalPositions,
            totalValueSponsored: totalSponsored,
            averagePerUser: totalUsers > 0 ? totalSponsored / totalUsers : 0
        },
        config: DLMM_CONFIG
    });
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 DLMM Enoki sponsor service running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`💰 Position sponsorship: POST /api/sponsor-position`);
    console.log(`🚀 Execute position: POST /api/execute-position`);
    console.log(`📊 Analytics: GET /api/sponsorship-stats`);
    console.log(`📦 DLMM Package: ${DLMM_CONFIG.PACKAGE_ID}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully');
    process.exit(0);
});