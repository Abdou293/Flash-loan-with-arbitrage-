# دليل تقديم المشروع على Upwork (بالعربية)

الروابط التي ستستخدمها:
- **GitHub:** https://github.com/Abdou293/Flash-loan-with-arbitrage-
- **اللوحة الحية (بيانات حقيقية في وضع shadow):** https://defi-execution-engine-dashboard.onrender.com
- **لقطتا الشاشة:** `docs/screenshots/dashboard-desktop.png` و`docs/screenshots/dashboard-mobile.png`

## كيف تعرض المشروع
1. **أضف المشروع إلى قسم Portfolio.** الأفضل عنصر رئيسي واحد (DeFi Execution Engine) وتحته عنصران للوحدتين، وفي وصف كل عنصر جملة "Part of the same repository". لا تقدّمها كثلاثة مشاريع مستقلة، فهي مستودع واحد.
2. **اجعل رابط GitHub هو الدليل الأساسي.** العميل التقني سيفتح README أولًا، وفيه اختبارات ناجحة وقسم النتائج وقسم "Limitations and risks".
3. **كن صريحًا.** اذكر أن المشروع تعليمي، وأنه يعمل في dry-run/shadow فقط، وأنك استخدمت الذكاء الاصطناعي في التطوير، وأن العقود لم تُدقَّق أمنيًا من طرف خارجي ولم تُنشر على mainnet.
4. **يمكنك ذكر نتائج القياس بوصفها قياسات، ولا تذكر أرباحًا أبدًا.** نتائجنا هي: المراجحة غير مربحة بالبنية المجانية، وفرص التصفية يأخذها محترفون في نفس البلوك. هذه القصة السلبية الصادقة هي نقطة قوتك، فهي تُثبت أنك تقيس قبل أن تبني.
5. **حدّد خدماتك الواقعية:** عقود Solidity مع اختبارات Foundry (mocks وfork واختبار طفرات)، وبوتات TypeScript بإدارة مخاطر ومحاكاة، وأدوات قياس على بيانات السلسلة، ولوحات متابعة، وفحص الأسرار وCI. لا تعرض "بوتات تربح مضمونة".
6. **في العروض (proposals):** اربط المشروع بحاجة العميل مباشرة، وأرسل رابطي GitHub واللوحة (نموذج جاهز أدناه).
7. **قبل أن تعلن المستودع:** نفّذ `docs/SECURITY_CHECKLIST.md`، وتأكد أن المستودع Public، وأن `scripts/secret-scan.sh` نظيف.
8. **شرح الأرقام للعملاء:** اقرأ `docs/LEADS_TALKING_POINTS_AR.md`.

## Portfolio entry 1 (main): DeFi Execution Engine on Arbitrum
**Title:** DeFi Execution Engine on Arbitrum: flash-loan arbitrage and Aave liquidations (dry-run, measured on real data)

One engine with two modules, built and tested end to end. Both modules borrow with zero-interest flash loans (Balancer V2, Uniswap V4)
and revert the whole transaction unless a minimum profit is met. Solidity contracts (owner-only, pause switch, lender-only
callbacks bound to loans the contract itself started, router allow-list) are covered by Foundry mock tests, tests against a
real Arbitrum fork, and mutation testing (9 deliberate breakages, all caught). A TypeScript bot adds a profit calculator,
risk engine, pre-send simulation, backtesting, a block-level gap radar, an Aave liquidation measurement tool and a borrower
health monitor. A static dashboard (Render) shows real shadow-mode data and the past studies.

What the measurements found (read-only, real Arbitrum data): flash-loan arbitrage on mainstream pools was not profitable with
free infrastructure, and the profitable Aave liquidations (about $155k of gross bonus in 30 days across all liquidators)
were taken in the same block by a few specialised bots. I report this as a result, not as a failure of the engineering.

Honest scope: AI-assisted development, directed and verified by me; not audited; not deployed to mainnet; dry-run / shadow
mode only; no profit claims.

Links: GitHub (README with results and limits) and the live dashboard.
Tech: Solidity, Foundry, OpenZeppelin, TypeScript, ethers v6, Vitest, Multicall3, gitleaks, GitHub Actions, Render.

## Portfolio entry 2 (module): Flash-Loan Arbitrage Bot (Arbitrum)
Part of the same repository as the engine. A Solidity executor (`FlashArb.sol`, 29 mock tests plus real-fork tests) and a
TypeScript plug-in bot with four strategies (cross-DEX, triangular, fee-tier, new-pool scanner), a profit calculator
(DEX fees, slippage reserve, gas), a risk engine and a backtester. Measured on 24 h of recorded real quotes (2,976 routes),
block-level radar on 91 pools, and a live shadow run (180 cycles, 9,720 routes priced): no route stayed profitable after
costs. Dry-run only, not audited, no profit claims.

## Portfolio entry 3 (module): Aave V3 Liquidation Bot (Arbitrum)
Part of the same repository as the engine. `FlashLiquidator.sol` repays a borrower's debt with a zero-interest flash loan,
receives the collateral plus the liquidation bonus, swaps it back and reverts unless the profit target is met (32 mock tests,
6 tests against real Aave on a fork, 9/9 mutations caught). A read-only measurement tool analysed 1,031 liquidations over
30 days (who liquidates, how fast, how much), and a borrower health monitor ran in shadow mode on 93 accounts. Finding:
the market is real but crowded; the bot is a technical demonstration, not a profit source. Dry-run only, not audited.

## Short proposal template (English)
> Hi, I build DeFi bots and contracts and I measure an idea on real data before building around it. A recent example is my
> Arbitrum execution engine (GitHub + live dashboard below): Solidity contracts with Foundry fork tests and mutation testing,
> a TypeScript bot with a risk engine and pre-send simulation, and read-only studies of real arbitrage and liquidation data.
> For your project I would start with [one concrete step: scope the strategy, write the contract and tests, build the
> monitor]. I do not promise profits; I give you honest measurements and clean, tested code.

## Skills to list
Solidity, Foundry, Smart contract testing, TypeScript, Node.js, ethers.js, DeFi, Web3, Blockchain data analysis, Bots.
