
![npm](https://img.shields.io/npm/v/@debut/community-core)
![npm](https://img.shields.io/npm/dm/@debut/community-core)
![NPM](https://img.shields.io/npm/l/@debut/community-core)
[![Support me on Patreon](https://img.shields.io/endpoint.svg?url=https%3A%2F%2Fshieldsio-patreon.vercel.app%2Fapi%3Fusername%3Dbusinessduck%26type%3Dpatrons%26suffix%3DEnterprise%2520users&style=flat)](https://patreon.com/businessduck)
[![Telegram crypto trading orders stream](https://badgen.net/badge/telegram/crypt:stream/blue?icon=telegram)](https://t.me/debutjs)
[![Telegram stocks trading orders stream](https://badgen.net/badge/telegram/stocks:stream/cyan?icon=telegram)](https://t.me/debutjs2)
# Trading Strategies Based on Debut/Community Edition

Debut is an ecosystem for developing and launching trading strategies. An analogue of the well-known `ZenBot`, but with much more flexible possibilities for constructing strategies. All you need to do is come up with and describe the entry points to the market and connect the necessary [plugins](https://github.com/debut-js/Plugins) to work. Everything else is a matter of technology: **genetic algorithms** - will help you choose the most effective parameters for the strategy (period, stops, and others), **ticker selection module** - will help you find an asset suitable for the strategy (token or share), on which it will work best.

Debut is based on the architecture of the core and add-on plugins that allow flexible customization of any solutions. The main goal of the entire Debut ecosystem is to simplify the process of creating and launching working trading robots on various exchanges.

## Available for

<p>
    <img src="/.github/assets/alpaca.png" alt="Alpaca API" width="64">
    <img src="/.github/assets/binance.png" alt="Binance API" width="64">
    <img src="/.github/assets/tinkoff.png" alt="Tinkoff API (Russia only)" width="64">
    <a href="https://www.patreon.com/bePatron?u=57560983"><img src="/.github/assets/buy2.png" alt="Request implementation" width="64"></a>
</p>

## Premium access
### @debut/enterprise-core

<h5> Timeframe Aggregator </h5>
This is a kernel module responsible for aggregating candlesticks `1min` ticks in any other available time periods.
It allows you to create timeframes supported by `Debut` even if they are not supported by the broker. And also get access to a candlestick of any higher timeframe, for example, build daily support and resistance levels, take indicator readings from four hourly candles, and much more. Below is an example of registering access to a `day` timeframe.

<h5> Advanced tick emulation </h5>
Allows to emulate ticks in a test environment with maximum accuracy, by creating price changes based on `1min` ticks, split into open, high, low, close. To collect timeframes, the aggregation module into candles of any time interval is used.


<h5> Additional callbacks in plugins </h5>
Additional callbacks are used in the premium version of Debut to expand the functionality of creating plugins. More details can be found in the plugins description section.

The Enterprise version is a ready-made set of tools for "big guys", for those who are engaged in trade services or create strategies professionally. Everything is here! And this is all ready to work for you and to increase the speed of your development. **($15/mo [buy now!](https://www.patreon.com/bePatron?u=57560983))**

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
<td> Report analyzer for `finder`. Creates screenshots from json files of reports and groups them according to efficiency </td>
<td align="center"> ❌ </td>
<td align="center"> ✅ </td>
</tr>
</tbody> </table>

### Personal edition
*Have no strategies from out of the box.*

- Enterprise core inside!
- Report with order screenshots and stats in to you messenger direct
- Money management formula for strategy equity auto calculation
- Fast genetic result analyser and viewer
- Private chat support
- Ready to start on VPS/VDS or cloud
- Dashboard* [still in progress]

### Business edition
- Multiple tokens for easy client connection (signals for sale to you clients)
- Legal use Debut for business

## Strategy Import from TradingView ($1000 [buy now!](https://www.patreon.com/bePatron?u=57560983))
If you need help transferring a strategy from TradingView to the Debut ecosystem. Transferring a strategy takes up to 3 business days. You can also request to create a strategy based on an article or your own formula.

We are streaming Enterprise-based deals live on our [telegram channel](https://t.me/debutjs)

**Find out the price by sending a request to [sales@debutjs.io](mailto:sales@debutjs.io)**

**Remember!** Starting a bot and trading in general requires careful study of the associated risks and parameters.
Incorrect settings can cause serious financial losses.

## System requirements
To work, you need [NodeJS 14.xx/npm 7.xx](https://nodejs.org/en/) ([installation instructions](https://htmlacademy.ru/blog/boost/tools/installing-nodejs))

## [Documentation](https://debutjs.io)
# Installation and configuration

```bash
npm i @debut/community-core
```
