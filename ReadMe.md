
![npm](https://img.shields.io/npm/v/@debut/community-core)
![npm](https://img.shields.io/npm/dm/@debut/community-core)
![NPM](https://img.shields.io/npm/l/@debut/community-core)
[![Support me on Patreon](https://img.shields.io/endpoint.svg?url=https%3A%2F%2Fshieldsio-patreon.vercel.app%2Fapi%3Fusername%3Dbusinessduck%26type%3Dpatrons%26suffix%3DEnterprise%2520users&style=flat)](https://patreon.com/businessduck)
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

## Community edition
We believe in the power of the community! That is why we decided to publish the project. The community version is free, but it has some limitations in commercial use (income from trading startups is not commerce), as well as technical differences in testing strategies. Join the community, join **[developer chat](https://t.me/joinchat/Acu2sbLIy_c0OWIy)**

## Enterprise edition ($100/mo [buy now!](https://www.patreon.com/bePatron?u=57560983))
Enterprise version is a ready-made set of tools for "big guys", for those who are engaged in trade services or create strategies professionally. Everything is here! And this is all ready to work for you and to increase the speed of your development.


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
</tbody> </table>

## Personal edition
*Have no strategies from out of the box.*

- Enterprise core inside!
- Report with order screenshots and stats in to you messenger direct
- Money management formula for strategy equity auto calculation
- Fast genetic result analyser and viewer
- Private chat support
- Ready to start on VPS/VDS or cloud
- Dashboard* [still in progress]


## Business edition
- Multiple tokens connection (signals for sale to you clients)
- Legal use Debut for business applications

We are streaming Enterprise-based deals live on our [telegram channel](https://t.me/debutjs)

**Find out the price by sending a request to [sales@debutjs.io](mailto:sales@debutjs.io)**

**Disclaimer**

- Debut does not guarantee 100% probability of making a profit. Use it at your own peril and risk, relying on your own professionalism.
- Cryptocurrency is a global experiment, so Debut is also. That is, both can fail at any time.
All you need to know

**Remember!** Starting a bot and trading in general requires careful study of the associated risks and parameters.
Incorrect settings can cause serious financial losses.

## System requirements
To work, you need [NodeJS 14.xx/npm 7.xx](https://nodejs.org/en/) ([installation instructions](https://htmlacademy.ru/blog/boost/tools/installing-nodejs))

## [Documentation](https://debutjs.io)
# Installation and configuration

```bash
npm i @debut/community-core
```
