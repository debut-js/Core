![npm](https://img.shields.io/npm/v/@debut/community-core)
![npm](https://img.shields.io/npm/dm/@debut/community-core)
![NPM](https://img.shields.io/npm/l/@debut/community-core)
[![Support me on Patreon](https://img.shields.io/endpoint.svg?url=https%3A%2F%2Fshieldsio-patreon.vercel.app%2Fapi%3Fusername%3Dbusinessduck%26type%3Dpatrons%26suffix%3DEnterprise%2520users&style=flat)](https://patreon.com/businessduck)
[![Telegram crypto trading orders stream](https://badgen.net/badge/tg/crypt:stream/blue?icon=telegram)](https://t.me/debutjs)
[![Telegram stocks trading orders stream](https://badgen.net/badge/tg/stocks:stream/cyan?icon=telegram)](https://t.me/debutjs2)
# Trading Strategies Based on Debut/Community Edition

Debut is an ecosystem for developing and launching trading strategies. An analogue of the well-known `ZenBot`, but with much more flexible possibilities for constructing strategies. All you need to do is come up with and describe the entry points to the market and connect the necessary [plugins](https://github.com/debut-js/Plugins) to work. Everything else is a matter of technology: **genetic algorithms** - will help you choose the most effective parameters for the strategy (period, stops, and others), **ticker selection module** - will help you find an asset suitable for the strategy (token or share), on which it will work best.

Debut is based on the architecture of the core and add-on plugins that allow flexible customization of any solutions. The main goal of the entire Debut ecosystem is to simplify the process of creating and launching working trading robots on various exchanges.

## Available for

<p>
    <img src="https://github.com/debut-js/Core/blob/master/.github/assets/alpaca.png" alt="Alpaca API" width="64">
    <img src="https://github.com/debut-js/Core/blob/master/.github/assets/binance.png" alt="Binance API" width="64">
    <img src="https://github.com/debut-js/Core/blob/master/.github/assets/tinkoff.png" alt="Tinkoff API (Russia only)" width="64">
    <a href="https://www.patreon.com/bePatron?u=57560983"><img src="https://github.com/debut-js/Core/blob/master/.github/assets/buy2.png" alt="Request implementation" width="64"></a>
</p>

## Community edition
We believe in the power of the community! That is why we decided to publish the project. The community version is free, but it has some limitations in commercial use (income from trading startups is not commerce), as well as technical differences in testing strategies. Join the community, join **[developer chat](https://t.me/joinchat/Acu2sbLIy_c0OWIy)**

## Enterprise edition ($15/mo [buy now!](https://www.patreon.com/bePatron?u=57560983))
The Enterprise version is a fully functional version of Debut, with a maximum of possibilities for emulating real market behavior.

Aggregation of candles:
All candles are aggregated from incoming data from shorter time periods. This allows you to get access to any timeframe on the fly with only 1 candle stream real by subscription. So you can get daily candles from 15 minute ones.

Tick ​​emulation:
On the basis of candlestick aggregation, a mechanism for filling candles of any timeframe from OHLC / OLHC ticks of 1-minute candles has been created. This allows you to create more than 60 price ticks in one 15-minute interval or 240 ticks inside each 1 hour candle.

<table>
<thead>
<tr>
<th> Functionality </th>
<th> Community </th>
<th> Enterprise </th>
</tr>
</thead>
<tbody> <tr>
<td> Strategy Tester </td>
<td align="center"> ✅ </td>
<td align="center"> ✅ </td>
</tr>
<tr>
<td> Emulation of OHLC ticks in the tester </td>
<td align="center"> ✅ </td>
<td align="center"> ✅ </td>
</tr>
<tr>
<td> Search modle (finder) suitable for the strategy of assets </td>
<td align="center"> ✅ </td>
<td align="center"> ✅ </td>
</tr>
<tr>
<td> Walk Forward Optimization </td>
<td align="center"> ✅ </td>
<td align="center"> ✅ </td>
</tr>
<tr>
<td> M1 candlestick data for tick emulation </td>
<td align="center"> ❌ </td>
<td align="center"> ✅ </td>
</tr>
<tr>
<td> Synthetic emulation of ticks in the tester (tick size no more than 0.75%) </td>
<td align="center"> ❌ </td>
<td align="center"> ✅ </td>
</tr>
<tr>
<td> Access to major candles from working timeframe</td>
<td align="center"> ❌ </td>
<td align="center"> ✅ </td>
</tr>
<tr>
<td> <b>Alpaca</b> supports `5min`, `15min` and others Debut timeframes </td>
<td align="center"> ❌ </td>
<td align="center"> ✅ </td>
</tr>
</tbody> </table>

We are streaming Enterprise-based deals live on our [telegram channel](https://t.me/debutjs)

**Find out the price by sending a request to [sales@debutjs.io](mailto:sales@debutjs.io)**

**Remember!** Starting a bot and trading in general requires careful study of the associated risks and parameters.
Incorrect settings can cause serious financial losses.

The project has two starting trading strategies "For example" how to work with the system.

An example of the strategy [SpikesG](/src/strategies/spikes-grid/ReadMe.md) in 200 days. Optimization was carried out in 180 days and 20 days of free work on untrained data.
An initial deposit of *$500 was used*

<p align="center"> <img src="/src/strategies/spikes-grid/img/BATUSDT.png" width="800"> </p>

Strategy statistics were collected based on the [plugin statistics](https://github.com/debut-js/Plugins/tree/master/packages/stats), follow the link to learn more about the meaning of some statistics.

Visualization is done using the [Report plugin](https://github.com/debut-js/Plugins/tree/master/packages/report).

## System requirements
To work, you need [NodeJS 14.xx/npm 7.xx](https://nodejs.org/en/) ([installation instructions](https://htmlacademy.ru/blog/boost/tools/installing-nodejs))

## [Documentation](https://debutjs.io)
