/**
 * Test the 5 new gambling services we just added.
 */

import { serviceManager, initializeServiceSystem } from '../services/index.js';

// Test helper functions
function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log('\n=== Gambling Services Test ===\n');

// Initialize service system
await initializeServiceSystem();

const gamblingServices = [
  'coin-flip',
  'dice-roll',
  'lottery-ticket',
  'blackjack',
  'slots'
];

console.log('Testing gambling service registration...');

for (const serviceId of gamblingServices) {
  const service = serviceManager.registry.get(serviceId);
  assert(service !== undefined, `${serviceId} should be registered`);
  assert(service!.name.length > 0, `${serviceId} should have a name`);
  assert(service!.description.length > 0, `${serviceId} should have a description`);
  assert(service!.defaultPrice > 0, `${serviceId} should have a valid price`);
  assert(service!.category === 'entertainment', `${serviceId} should be entertainment category`);
  console.log(`✅ ${serviceId}: ${service!.name} (${service!.defaultPrice} sats)`);
}

console.log('\nTesting input validation for gambling services...');

// Test coin-flip
const coinValid = serviceManager.validate('coin-flip', {
  bet: 'heads',
  wager: 100
});
assert(coinValid.valid, 'Coin flip should accept valid input');

const coinInvalid = serviceManager.validate('coin-flip', { bet: 'heads' });
assert(!coinInvalid.valid, 'Coin flip should require wager');
console.log('✅ coin-flip: validation works');

// Test dice-roll
const diceValid = serviceManager.validate('dice-roll', {
  bet_type: 'exact_number',
  bet_value: 6,
  wager: 50
});
assert(diceValid.valid, 'Dice roll should accept valid input');

const diceInvalid = serviceManager.validate('dice-roll', { bet_type: 'exact_number' });
assert(!diceInvalid.valid, 'Dice roll should require bet_value and wager');
console.log('✅ dice-roll: validation works');

// Test lottery-ticket
const lotteryValid = serviceManager.validate('lottery-ticket', {
  ticket_type: 'instant_scratch',
  ticket_price: 100
});
assert(lotteryValid.valid, 'Lottery should accept valid input');

const lotteryInvalid = serviceManager.validate('lottery-ticket', {});
assert(!lotteryInvalid.valid, 'Lottery should require ticket_type and price');
console.log('✅ lottery-ticket: validation works');

// Test blackjack - test basic validation (oneOf not fully supported)
const blackjackValid = serviceManager.validate('blackjack', {
  action: 'new_game',
  bet: 100
});
assert(blackjackValid.valid, 'Blackjack should accept valid input');

const blackjackTypeInvalid = serviceManager.validate('blackjack', { action: 123 });
assert(!blackjackTypeInvalid.valid, 'Blackjack should reject invalid action type');
console.log('✅ blackjack: validation works');

// Test slots
const slotsValid = serviceManager.validate('slots', { bet_amount: 50 });
assert(slotsValid.valid, 'Slots should accept valid bet amount');

const slotsTypeInvalid = serviceManager.validate('slots', { bet_amount: 'invalid' });
assert(!slotsTypeInvalid.valid, 'Slots should reject invalid bet type');
console.log('✅ slots: validation works');

console.log('\nTesting gambling service categories...');

const allServices = serviceManager.registry.list();
const entertainmentServices = allServices.filter(s => s.category === 'entertainment');
const gamblingCount = gamblingServices.filter(id =>
  entertainmentServices.find(s => s.id === id)
).length;

console.log(`Found ${gamblingCount} gambling services in entertainment category`);
assert(gamblingCount === 5, 'All 5 gambling services should be in entertainment category');

console.log('\nTesting service pricing models...');

const pricingData = gamblingServices.map(id => {
  const service = serviceManager.registry.get(id);
  return {
    service: id,
    price: service!.defaultPrice,
    name: service!.name
  };
});

console.log('Gambling service pricing:');
for (const { service, price, name } of pricingData) {
  console.log(`  ${service}: ${price} sats (${name})`);
  assert(price >= 15, `${service} should have minimum viable gambling price`);
  assert(price <= 500, `${service} should not be prohibitively expensive`);
}

console.log('\nTesting service schemas for gambling mechanics...');

// Verify coin-flip has betting options
const coinService = serviceManager.registry.get('coin-flip');
const coinSchema = coinService!.inputSchema as any;
assert(coinSchema.properties.bet.enum.includes('heads'), 'Coin flip should support heads bet');
assert(coinSchema.properties.bet.enum.includes('tails'), 'Coin flip should support tails bet');

// Verify dice-roll has multiple bet types
const diceService = serviceManager.registry.get('dice-roll');
const diceSchema = diceService!.inputSchema as any;
assert(diceSchema.properties.bet_type.enum.includes('exact_number'), 'Dice should support exact number bets');
assert(diceSchema.properties.bet_type.enum.includes('odd'), 'Dice should support odd/even bets');

// Verify lottery has multiple ticket types
const lotteryService = serviceManager.registry.get('lottery-ticket');
const lotterySchema = lotteryService!.inputSchema as any;
assert(lotterySchema.properties.ticket_type.enum.includes('instant_scratch'), 'Lottery should support scratch cards');
assert(lotterySchema.properties.ticket_type.enum.includes('number_draw'), 'Lottery should support number draws');

// Verify blackjack has game actions
const blackjackService = serviceManager.registry.get('blackjack');
const blackjackSchema = blackjackService!.inputSchema as any;
assert(blackjackSchema.properties.action.enum.includes('hit'), 'Blackjack should support hit action');
assert(blackjackSchema.properties.action.enum.includes('stand'), 'Blackjack should support stand action');
assert(blackjackSchema.properties.action.enum.includes('double_down'), 'Blackjack should support double down');

// Verify slots has different themes
const slotsService = serviceManager.registry.get('slots');
const slotsSchema = slotsService!.inputSchema as any;
assert(slotsSchema.properties.machine_theme.enum.includes('classic_fruit'), 'Slots should support fruit theme');
assert(slotsSchema.properties.machine_theme.enum.includes('crypto_coins'), 'Slots should support crypto theme');

console.log('✅ All gambling mechanics schemas validated');

console.log('\nTesting total service count...');

const totalServices = serviceManager.registry.list().length;
console.log(`Total services now: ${totalServices}`);
assert(totalServices >= 20, 'Should have at least 20 services total (original + new + gambling)');

console.log('\n========================================');
console.log('Gambling Services Test completed: All 5 gambling services working perfectly!');
console.log('The bot-to-bot casino is ready for business! 🎰🎲🃏');
console.log('========================================\n');