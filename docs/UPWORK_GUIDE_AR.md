# دليل تقديم المشروع على Upwork (بالعربية)

## كيف تعرض المشروع
1. **أضف المشروع إلى قسم Portfolio** في ملفك الشخصي: العنوان، وصف قصير بالإنجليزية (أدناه)، رابط GitHub، رابط لوحة Vercel، ولقطتا الشاشة من `docs/screenshots/`.
2. **اجعل رابط GitHub هو الدليل الأساسي.** العميل التقني سيفتح README أولًا، لذلك تأكد أنه يظهر اختبارات ناجحة وقسم "Limitations and risks".
3. **كن صريحًا.** اذكر أن المشروع تعليمي، وأنه يعمل في dry-run فقط، وأنك استخدمت الذكاء الاصطناعي في التطوير، وأن العقد لم يُدقَّق أمنيًا. الصراحة تزيد الثقة عند العملاء الجادين، وتحميك من ادعاءات لا تستطيع إثباتها.
4. **لا تكتب أرباحًا أو نسب نجاح** في الملف الشخصي أو العروض. لا توجد نتائج حقيقية بعد، وأي رقم اصطناعي من اللوحة ليس دليلًا.
5. **حدّد خدماتك الواقعية:** كتابة عقود Solidity مع اختبارات Foundry، وبناء بوتات TypeScript، ولوحات متابعة، واختبارات fork، وإعداد فحص الأسرار وCI. لا تعرض "بوتات تربح مضمونة".
6. **في العروض (proposals):** اربط المشروع بحاجة العميل مباشرة (مثلًا: "بنيت إطارًا لاستراتيجيات قابلة للتفعيل من ملف إعدادات مع محرك مخاطر ومحاكاة قبل الإرسال") وأرسل الرابطين.
7. **قبل النشر:** نفّذ `docs/SECURITY_CHECKLIST.md` بالكامل.

## Suggested Upwork project description (English)
**Flash Loan Arbitrage System on Arbitrum (educational portfolio project)**

A full-stack DeFi engineering project: a Solidity contract that borrows from Aave V3 and reverts the whole transaction unless a
minimum profit is met (owner-only execution, pause switch, callback restricted to the Aave pool, router allow-list), tested with
Foundry; a TypeScript plug-in bot with four strategy modules (cross-DEX, triangular, fee-tier, new-pool scanner), a profit
calculator (flash-loan fee, DEX fees, gas, slippage), a risk engine (min profit, max gas, size cap, auto-pause) and pre-send
simulation; a backtesting pipeline; and a static dashboard deployable on Vercel's free tier. Runs in dry-run mode only, with
gitleaks secret scanning and CI.

Honest scope: built with AI-assisted development; not audited; no profit claims; dry-run only. See the README for what has and
has not been tested.

Tech: Solidity, Foundry, OpenZeppelin, TypeScript, ethers v6, Vitest, GitHub Actions, Vercel.
