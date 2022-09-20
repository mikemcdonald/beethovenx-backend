import { UserSnapshotSubgraphService } from '../../subgraphs/user-snapshot-subgraph/user-snapshot-subgraph.service';
import { prisma } from '../../../prisma/prisma-client';
import { parseUnits } from 'ethers/lib/utils';
import moment from 'moment-timezone';
import { UserPoolSnapshot, UserPortfolioSnapshot } from '../user-types';
import { GqlUserSnapshotDataRange } from '../../../schema';
import { PoolSnapshotService } from '../../pool/lib/pool-snapshot.service';
import { formatFixed } from '@ethersproject/bignumber';
import { UserBalanceSnapshotsQuery } from '../../subgraphs/user-snapshot-subgraph/generated/user-snapshot-subgraph-types';
import { networkConfig } from '../../config/network-config';
import { Prisma, PrismaPoolSnapshot } from '@prisma/client';

export class UserSnapshotService {
    private readonly ONE_DAY_IN_SECONDS: number = 86400;

    constructor(
        private readonly userSnapshotSubgraphService: UserSnapshotSubgraphService,
        private readonly poolSnapshotService: PoolSnapshotService,
    ) {}

    public async getPortfolioSnapshots(accountAddress: string, numDays: number): Promise<UserPortfolioSnapshot[]> {
        throw new Error('Method not implemented.');
    }

    public async syncUserSnapshots() {
        // sync all snapshots that we have stored
    }

    public async getUserSnapshotsForPool(
        userAddress: string,
        poolId: string,
        range: GqlUserSnapshotDataRange,
    ): Promise<UserPoolSnapshot[]> {
        const oldestRequestedSnapshotTimestamp = this.getTimestampForRange(range);

        let storedUserSnapshotsFromRange = await this.getStoredSnapshotsForUserForPoolFromTimestamp(
            userAddress,
            oldestRequestedSnapshotTimestamp,
            poolId,
        );

        // no stored snapshots, retrieve from subgraph and store all non-0 snapshots
        if (storedUserSnapshotsFromRange.length === 0) {
            const userSnapshotsFromSubgraphForAllPools =
                await this.userSnapshotSubgraphService.getUserBalanceSnapshotsWithPaging(
                    0,
                    moment().unix(),
                    userAddress,
                );
            const pool = await prisma.prismaPool.findUniqueOrThrow({
                where: {
                    id: poolId,
                },
                include: {
                    staking: true,
                },
            });
            const userSnapshotsForPool = userSnapshotsFromSubgraphForAllPools.snapshots.filter((snapshot) => {
                if (pool.staking) {
                    return (
                        snapshot.walletTokens.includes(pool.address) ||
                        snapshot.farms.includes(pool.staking?.id) ||
                        snapshot.gauges.includes(pool.staking?.id)
                    );
                }
                return snapshot.walletTokens.includes(pool.address);
            });

            // user does not have any snapshots
            if (userSnapshotsForPool.length === 0) {
                return [];
            }

            // persists what we have in the subgraph
            await this.enrichAndPersistSnapshotsForPool({ snapshots: userSnapshotsForPool }, poolId);

            storedUserSnapshotsFromRange = await this.getStoredSnapshotsForUserForPoolFromTimestamp(
                userAddress,
                oldestRequestedSnapshotTimestamp,
                poolId,
            );
        }

        const poolSnapshots = await this.poolSnapshotService.getSnapshotsForPool(poolId, range);
        // find and fill in any gaps from first to last snapshot

        const userPoolSnapshots: UserPoolSnapshot[] = [];

        userPoolSnapshots.push({
            timestamp: storedUserSnapshotsFromRange[0].timestamp,
            walletBalance: storedUserSnapshotsFromRange[0].walletBalance,
            farmBalance: storedUserSnapshotsFromRange[0].farmBalance,
            gaugeBalance: storedUserSnapshotsFromRange[0].gaugeBalance,
            totalBalance: storedUserSnapshotsFromRange[0].totalBalance,
            totalValueUSD: storedUserSnapshotsFromRange[0].totalValueUSD,
            fees24h: storedUserSnapshotsFromRange[0].fees24h,
            percentShare: parseFloat(storedUserSnapshotsFromRange[0].percentShare),
        });
        let firstIteration = true;
        for (const snapshot of storedUserSnapshotsFromRange) {
            // skip first
            if (firstIteration) {
                firstIteration = false;
                continue;
            }
            while (
                userPoolSnapshots[userPoolSnapshots.length - 1].timestamp + this.ONE_DAY_IN_SECONDS <
                snapshot.timestamp
            ) {
                //need to fill the gap from last snapshot
                const previousUserSnapshot = userPoolSnapshots[userPoolSnapshots.length - 1];
                const currentTimestamp = previousUserSnapshot.timestamp + this.ONE_DAY_IN_SECONDS;
                const poolSnapshot = poolSnapshots.find((snapshot) => snapshot.timestamp === currentTimestamp);
                if (!poolSnapshot) {
                    continue;
                }
                const percentShare = parseFloat(previousUserSnapshot.totalBalance) / poolSnapshot.totalSharesNum;
                userPoolSnapshots.push({
                    timestamp: currentTimestamp,
                    walletBalance: previousUserSnapshot.walletBalance,
                    farmBalance: previousUserSnapshot.farmBalance,
                    gaugeBalance: previousUserSnapshot.gaugeBalance,
                    totalBalance: previousUserSnapshot.totalBalance,
                    percentShare: percentShare,
                    totalValueUSD: `${parseFloat(previousUserSnapshot.totalBalance) * (poolSnapshot.sharePrice || 0)}`,
                    fees24h: `${
                        percentShare * (poolSnapshot.fees24h || 0) * (1 - networkConfig.balancer.protocolFeePercent)
                    }`,
                });
            }
            userPoolSnapshots.push({
                timestamp: snapshot.timestamp,
                walletBalance: snapshot.walletBalance,
                farmBalance: snapshot.farmBalance,
                gaugeBalance: snapshot.gaugeBalance,
                totalBalance: snapshot.totalBalance,
                totalValueUSD: snapshot.totalValueUSD,
                fees24h: snapshot.fees24h,
                percentShare: parseFloat(snapshot.percentShare),
            });
        }

        // find and fill gap from last snapshot to today (if its balance is > 0)
        while (userPoolSnapshots[userPoolSnapshots.length - 1].timestamp < moment().startOf('day').unix()) {
            const lastSnapshot = userPoolSnapshots[userPoolSnapshots.length - 1];
            if (parseFloat(lastSnapshot.totalBalance) > 0) {
                const previousUserSnapshot = userPoolSnapshots[userPoolSnapshots.length - 1];
                const currentTimestamp = previousUserSnapshot.timestamp + this.ONE_DAY_IN_SECONDS;
                const poolSnapshot = poolSnapshots.find((snapshot) => snapshot.timestamp === currentTimestamp);
                if (!poolSnapshot) {
                    continue;
                }
                const percentShare = parseFloat(previousUserSnapshot.totalBalance) / poolSnapshot.totalSharesNum;
                userPoolSnapshots.push({
                    timestamp: currentTimestamp,
                    walletBalance: previousUserSnapshot.walletBalance,
                    farmBalance: previousUserSnapshot.farmBalance,
                    gaugeBalance: previousUserSnapshot.gaugeBalance,
                    totalBalance: previousUserSnapshot.totalBalance,
                    percentShare: percentShare,
                    totalValueUSD: `${parseFloat(previousUserSnapshot.totalBalance) * (poolSnapshot.sharePrice || 0)}`,
                    fees24h: `${
                        percentShare * (poolSnapshot.fees24h || 0) * (1 - networkConfig.balancer.protocolFeePercent)
                    }`,
                });
            }
        }

        return userPoolSnapshots;
    }

    private async enrichAndPersistSnapshotsForPool(
        userBalanceSnapshotsQuery: UserBalanceSnapshotsQuery,
        poolId: string,
    ) {
        const { snapshots: userBalanceSnapshots } = userBalanceSnapshotsQuery;

        // make sure users exists
        await prisma.prismaUser.upsert({
            where: { address: userBalanceSnapshots[0].user.id },
            update: {},
            create: { address: userBalanceSnapshots[0].user.id },
        });

        const poolInSnapshots = await prisma.prismaPool.findUniqueOrThrow({
            where: {
                id: poolId,
            },
            include: {
                staking: true,
            },
        });

        const prismaInput: Prisma.PrismaUserPoolBalanceSnapshotCreateManyInput[] = [];
        for (const snapshot of userBalanceSnapshots) {
            const poolSnapshotForTimestamp = await this.poolSnapshotService.getSnapshotForPool(
                poolId,
                snapshot.timestamp,
            );

            // if we don't have a snapshot for the pool, we can't calculate user snapshot -> skip
            if (!poolSnapshotForTimestamp) {
                continue;
            }

            const walletIdx = snapshot.walletTokens.indexOf(poolInSnapshots.address);
            const walletBalance = walletIdx !== -1 ? snapshot.walletBalances[walletIdx] : '0';
            const gaugeIdx = snapshot.gauges.indexOf(poolInSnapshots.staking?.id || '');
            const gaugeBalance = gaugeIdx !== -1 ? snapshot.gaugeBalances[gaugeIdx] : '0';
            const farmIdx = snapshot.farms.indexOf(poolInSnapshots.staking?.id || '');
            const farmBalance = farmIdx !== -1 ? snapshot.farmBalances[farmIdx] : '0';
            const totalBalanceScaled = parseUnits(walletBalance, 18)
                .add(parseUnits(gaugeBalance, 18))
                .add(parseUnits(farmBalance, 18));

            const percentShare =
                parseFloat(formatFixed(totalBalanceScaled, 18)) / poolSnapshotForTimestamp.totalSharesNum;

            prismaInput.push({
                id: `${poolInSnapshots.address}-${snapshot.user.id.toLowerCase()}-${snapshot.id}`,
                timestamp: snapshot.timestamp,
                userAddress: snapshot.user.id.toLowerCase(),
                poolId: poolInSnapshots.id,
                poolToken: poolInSnapshots.address,
                walletBalance,
                gaugeBalance,
                farmBalance,
                percentShare: `${percentShare}`,
                totalBalance: formatFixed(totalBalanceScaled, 18),
                totalValueUSD: `${
                    parseFloat(formatFixed(totalBalanceScaled, 18)) * (poolSnapshotForTimestamp?.sharePrice || 0)
                }`,
                fees24h: `${
                    percentShare *
                    (poolSnapshotForTimestamp?.fees24h || 0) *
                    (1 - networkConfig.balancer.protocolFeePercent)
                }`,
            });
        }
        await prisma.prismaUserPoolBalanceSnapshot.createMany({
            data: prismaInput,
        });
    }

    private async getStoredSnapshotsForUserForPoolFromTimestamp(
        userAddress: string,
        oldestRequestedSnapshotTimestamp: number,
        poolId: string,
    ) {
        return await prisma.prismaUserPoolBalanceSnapshot.findMany({
            where: {
                userAddress: userAddress,
                timestamp: {
                    gte: oldestRequestedSnapshotTimestamp,
                },
                poolId: poolId,
            },
            orderBy: { timestamp: 'asc' },
        });
    }

    private getTimestampForRange(range: GqlUserSnapshotDataRange): number {
        switch (range) {
            case 'THIRTY_DAYS':
                return moment().startOf('day').subtract(30, 'days').unix();
            case 'NINETY_DAYS':
                return moment().startOf('day').subtract(90, 'days').unix();
            case 'ONE_HUNDRED_EIGHTY_DAYS':
                return moment().startOf('day').subtract(180, 'days').unix();
            case 'ONE_YEAR':
                return moment().startOf('day').subtract(365, 'days').unix();
            case 'ALL_TIME':
                return 0;
        }
    }
}
