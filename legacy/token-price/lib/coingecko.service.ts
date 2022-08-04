import axios from 'axios';
import { twentyFourHoursInSecs } from '../../../modules/common/time';
import _ from 'lodash';
import {
    CoingeckoPriceResponse,
    HistoricalPrice,
    HistoricalPriceResponse,
    Price,
    TokenPrices,
} from '../token-price-types';
import moment from 'moment-timezone';
import { tokenService } from '../../../modules/token/token.service';
import { TokenDefinition } from '../../../modules/token/token-types';
import { getAddress, isAddress } from 'ethers/lib/utils';
import { networkConfig } from '../../../modules/config/network-config';

interface MappedToken {
    platform: string;
    address: string;
    originalAddress?: string;
}

export class CoingeckoService {
    private readonly baseUrl: string;
    private readonly fiatParam: string;
    private readonly platformId: string;
    private readonly nativeAssetId: string;
    private readonly nativeAssetAddress: string;

    constructor() {
        this.baseUrl = 'https://api.coingecko.com/api/v3';
        this.fiatParam = 'usd';
        this.platformId = networkConfig.coingecko.platformId;
        this.nativeAssetId = networkConfig.coingecko.nativeAssetId;
        this.nativeAssetAddress = networkConfig.chain.nativeAssetAddress;
    }

    public async getNativeAssetPrice(): Promise<Price> {
        try {
            const response = await this.get<CoingeckoPriceResponse>(
                `/simple/price?ids=${this.nativeAssetId}&vs_currencies=${this.fiatParam}`,
            );
            return response[this.nativeAssetId];
        } catch (error) {
            //console.error('Unable to fetch Ether price', error);
            throw error;
        }
    }

    /**
     *  Rate limit for the CoinGecko API is 10 calls each second per IP address.
     */
    public async getTokenPrices(addresses: string[], addressesPerRequest = 100): Promise<TokenPrices> {
        try {
            if (addresses.length / addressesPerRequest > 10) throw new Error('To many requests for rate limit.');

            const tokenDefinitions = await tokenService.getTokenDefinitions();
            const mapped = addresses.map((address) => this.getMappedTokenDetails(address, tokenDefinitions));
            const groupedByPlatform = _.groupBy(mapped, 'platform');

            const requests: Promise<CoingeckoPriceResponse>[] = [];

            _.forEach(groupedByPlatform, (tokens, platform) => {
                const mappedAddresses = tokens.map((token) => token.address);
                const pageCount = Math.ceil(mappedAddresses.length / addressesPerRequest);
                const pages = Array.from(Array(pageCount).keys());

                pages.forEach((page) => {
                    const addressString = mappedAddresses.slice(
                        addressesPerRequest * page,
                        addressesPerRequest * (page + 1),
                    );
                    const endpoint = `/simple/token_price/${platform}?contract_addresses=${addressString}&vs_currencies=${this.fiatParam}`;
                    const request = this.get<CoingeckoPriceResponse>(endpoint);
                    requests.push(request);
                });
            });

            const paginatedResults = await Promise.all(requests);
            const results = this.parsePaginatedTokens(paginatedResults, mapped);

            // Inject native asset price if included in requested addresses
            if (addresses.includes(this.nativeAssetAddress)) {
                results[this.nativeAssetAddress] = await this.getNativeAssetPrice();
            }

            return results;
        } catch (error) {
            //console.error('Unable to fetch token prices', addresses, error);
            throw error;
        }
    }

    public async getTokenHistoricalPrices(address: string, days: number): Promise<HistoricalPrice[]> {
        const now = Math.floor(Date.now() / 1000);
        const end = now;
        const start = end - days * twentyFourHoursInSecs;
        const tokenDefinitions = await tokenService.getTokenDefinitions();
        const mapped = this.getMappedTokenDetails(address, tokenDefinitions);

        const endpoint = `/coins/${mapped.platform}/contract/${mapped.address}/market_chart/range?vs_currency=${this.fiatParam}&from=${start}&to=${end}`;

        const result = await this.get<HistoricalPriceResponse>(endpoint);

        return result.prices.map((item) => ({
            //anchor to the start of the hour
            timestamp:
                moment
                    .unix(item[0] / 1000)
                    .startOf('hour')
                    .unix() * 1000,
            price: item[1],
        }));
    }

    private parsePaginatedTokens(paginatedResults: TokenPrices[], mappedTokens: MappedToken[]): TokenPrices {
        const results = paginatedResults.reduce((result, page) => ({ ...result, ...page }), {});
        const prices: TokenPrices = _.mapKeys(results, (val, address) => this.getAddress(address));

        for (const mappedToken of mappedTokens) {
            if (mappedToken.originalAddress && results[mappedToken.address]) {
                prices[this.getAddress(mappedToken.originalAddress)] = results[mappedToken.address];
            }
        }

        return prices;
    }

    /**
     * Support instances where a token address is not supported by the platform id, provide the option to use a different platform
     */
    public getMappedTokenDetails(address: string, tokens: TokenDefinition[]): MappedToken {
        const token = tokens.find((token) => token.address.toLowerCase() === address.toLowerCase());
        if (token && token.coingeckoPlatformId && token.coingeckoContractAddress) {
            return {
                platform: token.coingeckoPlatformId,
                address: isAddress(token.coingeckoContractAddress)
                    ? token.coingeckoContractAddress.toLowerCase()
                    : token.coingeckoContractAddress,
                originalAddress: address.toLowerCase(),
            };
        }

        return {
            platform: this.platformId,
            address: address.toLowerCase(),
        };
    }

    private getAddress(address: string) {
        return isAddress(address) ? getAddress(address) : address;
    }

    private async get<T>(endpoint: string): Promise<T> {
        const { data } = await axios.get(this.baseUrl + endpoint);
        return data;
    }
}

export const coingeckoService = new CoingeckoService();