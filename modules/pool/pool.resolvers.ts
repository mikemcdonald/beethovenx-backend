import { poolService } from './pool.service';
import { Resolvers } from '../../schema';
import { isAdminRoute } from '../util/resolver-util';
import { prisma } from '../util/prisma-client';

const balancerResolvers: Resolvers = {
    Query: {
        poolGetPool: async (parent, { id }, context) => {
            return poolService.getGqlPool(id);
        },
        poolGetPools: async (parent, args, context) => {
            return poolService.getGqlPools(args);
        },
        poolGetPoolsCount: async (parent, args, context) => {
            return poolService.getPoolsCount(args);
        },
        poolGetPoolFilters: async (parent, {}, context) => {
            return poolService.getPoolFilters();
        },
        poolGetSwaps: async (parent, args, context) => {
            return poolService.getPoolSwaps(args);
        },
        poolGetBatchSwaps: async (parent, args, context) => {
            const batchSwaps = await poolService.getPoolBatchSwaps(args);

            return batchSwaps.map((batchSwap) => ({
                ...batchSwap,
                swaps: batchSwap.swaps.map((swap) => ({
                    ...swap,
                    poolTokens: swap.pool.tokens
                        .filter((token) => token.address !== swap.pool.address)
                        .map((token) => token.address),
                })),
            }));
        },
        poolGetJoinExits: async (parent, args, context) => {
            return poolService.getPoolJoinExits(args);
        },
        poolGetUserSwapVolume: async (parent, args, context) => {
            return poolService.getPoolUserSwapVolume(args);
        },
        poolGetFeaturedPoolGroups: async (parent, args, context) => {
            return poolService.getFeaturedPoolGroups();
        },
        poolGetSnapshots: async (parent, { id, range }, context) => {
            return poolService.getSnapshotsForPool(id, range);
        },
    },
    Mutation: {
        poolSyncAllPoolsFromSubgraph: async (parent, {}, context) => {
            isAdminRoute(context);

            return poolService.syncAllPoolsFromSubgraph();
        },
        poolSyncNewPoolsFromSubgraph: async (parent, {}, context) => {
            isAdminRoute(context);

            return poolService.syncNewPoolsFromSubgraph();
        },
        poolLoadOnChainDataForAllPools: async (parent, {}, context) => {
            isAdminRoute(context);

            await poolService.loadOnChainDataForAllPools();

            return 'success';
        },
        poolUpdateLiquidityValuesForAllPools: async (parent, {}, context) => {
            isAdminRoute(context);

            await poolService.updateLiquidityValuesForAllPools();

            return 'success';
        },
        poolUpdateVolumeAndFeeValuesForAllPools: async (parent, {}, context) => {
            isAdminRoute(context);

            await poolService.updateVolumeAndFeeValuesForPools();

            return 'success';
        },
        poolSyncSwapsForLast48Hours: async (parent, {}, context) => {
            isAdminRoute(context);

            await poolService.syncSwapsForLast48Hours();

            return 'success';
        },
        poolLoadOnChainDataForPoolsWithActiveUpdates: async (parent, {}, context) => {
            isAdminRoute(context);

            await poolService.loadOnChainDataForPoolsWithActiveUpdates();

            return 'success';
        },
        poolSyncSanityPoolData: async (parent, {}, context) => {
            isAdminRoute(context);

            await poolService.syncSanityPoolData();

            return 'success';
        },
        poolUpdateAprs: async (parent, {}, context) => {
            isAdminRoute(context);

            await poolService.updatePoolAprs();

            return 'success';
        },
        poolSyncPoolAllTokensRelationship: async (parent, {}, context) => {
            isAdminRoute(context);

            await poolService.syncPoolAllTokensRelationship();

            return 'success';
        },
        poolReloadAllPoolAprs: async (parent, {}, context) => {
            isAdminRoute(context);

            await poolService.realodAllPoolAprs();

            return 'success';
        },
        poolSyncTotalShares: async (parent, {}, context) => {
            isAdminRoute(context);

            const items = await prisma.prismaPoolDynamicData.findMany({});

            for (const item of items) {
                await prisma.prismaPoolDynamicData.update({
                    where: { id: item.id },
                    data: { totalSharesNum: parseFloat(item.totalShares) },
                });
            }

            return 'success';
        },
        poolReloadStakingForAllPools: async (parent, args, context) => {
            isAdminRoute(context);

            await poolService.reloadStakingForAllPools();

            return 'success';
        },
        poolSyncStakingForPools: async (parent, args, context) => {
            isAdminRoute(context);

            await poolService.syncStakingForPools();

            return 'success';
        },
        poolUpdateLiquidity24hAgoForAllPools: async (parent, args, context) => {
            isAdminRoute(context);

            await poolService.updateLiquidity24hAgoForAllPools();

            return 'success';
        },
        poolLoadSnapshotsForAllPools: async (parent, args, context) => {
            isAdminRoute(context);

            await poolService.loadSnapshotsForAllPools();

            return 'success';
        },
    },
};

export default balancerResolvers;