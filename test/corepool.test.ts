import { BigNumber } from '@ethersproject/bignumber';
import { parseEther } from '@ethersproject/units';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { EscrowedModaERC20, ModaCorePool, Token } from '../typechain';
import {
	add,
	fastForward,
	fromTimestampBN,
	toTimestampBN,
	mineBlocks,
	YEAR,
	DAY,
	MILLIS,
	ADDRESS0,
	ROLE_TOKEN_CREATOR,
	MINUTE,
	ROLE_POOL_STAKING,
} from './utils';

const userBalances = [parseEther('2000'), parseEther('200')];
const userEscrowBalance = [parseEther('200'), parseEther('10')];
const claimSMODARewards = true;
const rolloverInvestment = false;

describe('Core Pool', () => {
	let token: Token;
	let escrowToken: EscrowedModaERC20;
	let corePool: ModaCorePool;
	let start = new Date();
	let owner: SignerWithAddress, user0: SignerWithAddress, user1: SignerWithAddress;

	beforeEach(async () => {
		[owner, user0, user1] = await ethers.getSigners();

		const tokenFactory = await ethers.getContractFactory('Token');
		token = (await upgrades.deployProxy(
			tokenFactory,
			[[user0.address, user1.address], userBalances],
			{
				kind: 'uups',
			}
		)) as Token;
		await token.deployed();

		const escrowTokenFactory = await ethers.getContractFactory('EscrowedModaERC20');
		escrowToken = (await escrowTokenFactory.deploy()) as EscrowedModaERC20;
		await escrowToken.deployed();
		await escrowToken.mint(user0.address, userEscrowBalance[0]);
		await escrowToken.mint(user1.address, userEscrowBalance[1]);

		const nextBlock = (await ethers.provider.getBlockNumber()) + 1;
		const corePoolFactory = await ethers.getContractFactory('ModaCorePool');
		corePool = (await corePoolFactory.deploy(
			token.address, // moda MODA ERC20 Token ModaERC20 address
			ADDRESS0, // This is a modaPool, so set to zero.
			escrowToken.address, // smoda sMODA ERC20 Token EscrowedModaERC20 address
			token.address, // poolToken token the pool operates on, for example MODA or MODA/ETH pair
			100, // weight number representing a weight of the pool, actual weight fraction is calculated as that number divided by the total pools weight and doesn't exceed one
			parseEther('150000'), // modaPerBlock initial MODA/block value for rewards
			10, // blocksPerUpdate how frequently the rewards gets updated (decreased by 3%), blocks
			nextBlock, // initBlock initial block used to calculate the rewards
			nextBlock + 1000 // endBlock block number when farming stops and rewards cannot be updated anymore
		)) as ModaCorePool;
		await corePool.deployed();

		await token.grantRole(ROLE_TOKEN_CREATOR, corePool.address);
		await escrowToken.grantRole(ROLE_TOKEN_CREATOR, corePool.address);
	});

	it('Should refuse any but a CorePool to create a pool stake', async () => {
		await expect(
			corePool.connect(user0).stakeAsPool(user1.address, parseEther('100'))
		).to.be.revertedWith(
			`AccessControl: account ${user0.address.toLowerCase()} is missing role ${ROLE_POOL_STAKING}`
		);
	});

	it('Should revert on invalid lock interval', async () => {
		let endDate: Date = new Date();
		endDate.setTime(start.getTime() + YEAR + DAY);
		let lockedUntil: BigNumber = BigNumber.from(endDate.getTime()).div(MILLIS);
		await expect(
			corePool.connect(user0).stake(parseEther('100'), lockedUntil, false)
		).to.be.revertedWith('invalid lock interval');
	});

	it('Should allow a user to unstake a locked deposit after 1 year. Claiming MODA', async () => {
		// Set up the balance first
		expect(await token.balanceOf(user0.address)).to.equal(userBalances[0]);

		// Calculate a suitable locking end date
		let endDate: Date = new Date();
		endDate.setTime(start.getTime() + YEAR - 10 * MINUTE);
		let lockUntil: BigNumber = toTimestampBN(endDate);
		//console.log('lockedUntil', lockUntil);
		const amount: BigNumber = parseEther('104');
		await token.connect(user0).approve(corePool.address, amount);
		expect(await token.allowance(user0.address, corePool.address)).to.equal(amount);
		await corePool.connect(user0).stake(amount, lockUntil, claimSMODARewards);

		// Staking moves the user's MODA from the Token contract to the CorePool.
		expect(await token.balanceOf(user0.address)).to.equal(userBalances[0].sub(amount));
		//console.log(contractTx);
		expect(await corePool.getDepositsLength(user0.address)).to.equal(1);
		let [
			tokenAmount, // @dev token amount staked
			weight, //      @dev stake weight
			lockedFrom, //  @dev locking period - from
			lockedUntil, // @dev locking period - until
			isYield, //     @dev indicates if the stake was created as a yield reward
		] = await corePool.getDeposit(user0.address, 0);
		expect(tokenAmount).to.equal(amount);
		expect(weight).to.equal(parseEther('207997920'));
		expect(lockedUntil).to.equal(lockUntil);
		expect(isYield).to.equal(false);

		// Now attempt to withdraw it.
		await expect(
			corePool.connect(user0).unstake(parseEther('0'), amount, claimSMODARewards)
		).to.be.revertedWith('deposit not yet unlocked');
		// Wait for more than a year though and...
		await fastForward(add(start, { years: 1, days: 1 }));
		await mineBlocks(1000);
		// Before unstake executes the user should have zero sMODA.
		expect(await escrowToken.balanceOf(user0.address)).to.equal(userEscrowBalance[0]);
		await corePool.connect(user0).processRewards(claimSMODARewards);
		await corePool.connect(user0).unstake(0, amount, claimSMODARewards);

		// Examine the tokens this address now owns.
		expect(await token.balanceOf(user0.address)).to.equal(userBalances[0]);
		await corePool.processRewards(claimSMODARewards);

		expect(await escrowToken.balanceOf(user0.address)).to.equal(
			BigNumber.from('149400199999923851360000000')
		);
		// Is there anything remaining?
		expect(await corePool.getDepositsLength(user0.address)).to.equal(1);
		// Let's look
		[
			tokenAmount, // @dev token amount staked
			weight, //      @dev stake weight
			lockedFrom, //  @dev locking period - from
			lockedUntil, // @dev locking period - until
			isYield, //     @dev indicates if the stake was created as a yield reward
		] = await corePool.getDeposit(user0.address, 0);
		expect(tokenAmount).to.equal(0);
		expect(weight).to.equal(0);
		expect(lockedFrom).to.equal(0);
		expect(lockedUntil).to.equal(0);
		expect(isYield).to.equal(false);
	});

	it('Should allow a user to stake deposit for 1 month. Claim SMODA rewards.', async () => {
		//logSetup();
		// Set up the balance first
		expect(await token.balanceOf(user0.address)).to.equal(userBalances[0]);

		// Calculate a suitable locking end date
		let endDate: Date = add(start, { days: 28 });
		let lockUntil: BigNumber = BigNumber.from(endDate.getTime()).div(MILLIS);
		//console.log('lockedUntil', lockUntil);
		const amount: BigNumber = parseEther('104');
		await token.connect(user0).approve(corePool.address, amount);
		expect(await token.allowance(user0.address, corePool.address)).to.equal(amount);
		await corePool.connect(user0).stake(amount, lockUntil, claimSMODARewards);

		// Staking moves the user's MODA from the Token contract to the CorePool.
		expect(await token.balanceOf(user0.address)).to.equal(userBalances[0].sub(amount));
		//console.log(contractTx);
		expect(await corePool.getDepositsLength(user0.address)).to.equal(1);

		// Now attempt to withdraw it.
		await expect(
			corePool.connect(user0).unstake(parseEther('0'), parseEther('100'), claimSMODARewards)
		).to.be.revertedWith('deposit not yet unlocked');
		// Wait for less than 28 days and expect failure.
		await fastForward(add(start, { days: 27 }));
		// Before unstake executes the user should have zero sMODA.
		expect(await escrowToken.balanceOf(user0.address)).to.equal(userEscrowBalance[0]);
		await expect(corePool.connect(user0).unstake(0, amount, claimSMODARewards)).to.be.revertedWith(
			'deposit not yet unlocked'
		);

		// Wait a little longer though
		await fastForward(add(start, { days: 29 }));
		// Before unstake executes the user should have zero sMODA.
		expect(await escrowToken.balanceOf(user0.address)).to.equal(userEscrowBalance[0]);
		await corePool.connect(user0).unstake(0, amount, claimSMODARewards);

		// Examine the tokens this address now owns.
		expect(await token.balanceOf(user0.address)).to.equal(userBalances[0]);
		expect((await escrowToken.balanceOf(user0.address)).gt(parseEther('75019')));
		// Is there anything remaining?
		expect(await corePool.getDepositsLength(user0.address)).to.equal(1);
		// Examining the only deposit.
		let [
			tokenAmount, // @dev token amount staked
			weight, //      @dev stake weight
			lockedFrom, //  @dev locking period - from
			lockedUntil, // @dev locking period - until
			isYield, //     @dev indicates if the stake was created as a yield reward
		] = await corePool.getDeposit(user0.address, 0);
		expect(tokenAmount).to.equal(0); // It's all gone.
		expect(weight).to.equal(0);
		expect(lockedFrom).to.equal(0);
		expect(lockedUntil).to.equal(0);
		expect(isYield).to.equal(false);
	});

	it('Should allow a user to stake 1 month, unstake some, wait and unstake the rest (useSMODA)', async () => {
		//logSetup();
		// Set up the balance first
		expect(await token.balanceOf(user0.address)).to.equal(userBalances[0]);

		// Calculate a suitable locking end date
		let endDate: Date = new Date();
		endDate.setTime(start.getTime() + 28 * DAY);
		let lockUntil: BigNumber = BigNumber.from(endDate.getTime()).div(MILLIS);
		//console.log('lockedUntil', lockUntil);
		const amount: BigNumber = parseEther('104');
		await token.connect(user0).approve(corePool.address, amount);
		expect(await token.allowance(user0.address, corePool.address)).to.equal(amount);
		await corePool.connect(user0).stake(amount, lockUntil, claimSMODARewards);

		// Staking moves the user's MODA from the Token contract to the CorePool.
		expect(await token.balanceOf(user0.address)).to.equal(userBalances[0].sub(amount));
		//console.log(contractTx);
		expect(await corePool.getDepositsLength(user0.address)).to.equal(1);

		// Now attempt to withdraw it.
		await expect(
			corePool.connect(user0).unstake(parseEther('0'), parseEther('104'), claimSMODARewards)
		).to.be.revertedWith('deposit not yet unlocked');
		// Wait for less than a 28 days and expect failure.
		await fastForward(add(start, { days: 27 }));
		// Before unstake executes the user should have zero sMODA.
		expect(await escrowToken.balanceOf(user0.address)).to.equal(userEscrowBalance[0]);
		await expect(
			corePool.connect(user0).unstake(0, amount.div(2), claimSMODARewards)
		).to.be.revertedWith('deposit not yet unlocked');

		// Wait a little longer though
		await fastForward(add(start, { days: 29 }));
		// Before unstake executes the user should have zero sMODA.
		expect(await escrowToken.balanceOf(user0.address)).to.equal(userEscrowBalance[0]);
		await corePool.connect(user0).unstake(0, amount.div(2), claimSMODARewards);

		// Examine the tokens this address now owns.
		expect(await token.balanceOf(user0.address)).to.equal(userBalances[0].sub(amount.div(2)));
		expect(await escrowToken.balanceOf(user0.address)).to.equal(
			BigNumber.from('750199999918367744000000')
		);
		// Is there anything remaining?
		expect(await corePool.getDepositsLength(user0.address)).to.equal(1);
		// Examining the only deposit.
		let [
			tokenAmount, // @dev token amount staked
			weight, //      @dev stake weight
			lockedFrom, //  @dev locking period - from
			lockedUntil, // @dev locking period - until
			isYield, //     @dev indicates if the stake was created as a yield reward
		] = await corePool.getDeposit(user0.address, 0);
		expect(tokenAmount).to.equal(amount.div(2));
		expect(weight.eq(parseEther('55989024')));
		//expect(lockedFrom).to.equal(lockUntil);
		expect(lockedUntil).to.equal(lockUntil);
		expect(isYield).to.equal(false);

		// Wait another month
		await fastForward(add(start, { months: 2 }));
		// Before unstake executes the user should have the previous sMODA balance.
		expect(await escrowToken.balanceOf(user0.address)).to.equal(
			BigNumber.from('750199999918367744000000')
		);
		// Unstake whatever remains.
		await corePool.connect(user0).unstake(0, tokenAmount, claimSMODARewards);

		// Examine the tokens this address now owns.
		expect(await token.balanceOf(user0.address)).to.equal(userBalances[0]);
		expect(await escrowToken.balanceOf(user0.address)).to.equal(
			BigNumber.from('1041199999913121248000000')
		);

		[
			tokenAmount, // @dev token amount staked
			weight, //      @dev stake weight
			lockedFrom, //  @dev locking period - from
			lockedUntil, // @dev locking period - until
			isYield, //     @dev indicates if the stake was created as a yield reward
		] = await corePool.getDeposit(user0.address, 0);
		expect(tokenAmount).to.equal(0);
		expect(weight).to.equal(0);
		expect(lockedFrom).to.equal(0);
		expect(lockedUntil).to.equal(0);
		expect(isYield).to.equal(false);
	});

	it('Should allow a user to stake 1 month, unstake some, wait and unstake the rest (use MODA)', async () => {
		//logSetup();
		// Set up the balance first
		expect(await token.balanceOf(user0.address)).to.equal(userBalances[0]);

		// Calculate a suitable locking end date
		let endDate: Date = add(start, { days: 28 });

		let lockUntil: BigNumber = toTimestampBN(endDate);
		//console.log('lockUntil', lockUntil);

		const amount: BigNumber = parseEther('104');
		await token.connect(user0).approve(corePool.address, amount);
		expect(await token.allowance(user0.address, corePool.address)).to.equal(amount);
		await corePool.connect(user0).stake(amount, lockUntil, rolloverInvestment);

		// Is there a new Deposit?
		expect(await corePool.getDepositsLength(user0.address)).to.equal(1);
		// DEPOSIT 0
		let lastLocked = BigNumber.from(0);
		let [
			tokenAmount, // @dev token amount staked
			weight, //      @dev stake weight
			lockedFrom, //  @dev locking period - from
			lockedUntil, // @dev locking period - until
			isYield, //     @dev indicates if the stake was created as a yield reward
		] = await corePool.getDeposit(user0.address, 0);
		expect(tokenAmount.eq(amount));
		expect(weight.eq(BigNumber.from('111977944000000000000000000')));
		//expect(lockedFrom).to.equal(lockUntil); // timey wimey
		expect(lockedUntil).to.equal(lockUntil);
		expect(isYield).to.equal(false);

		// Staking moves the user's MODA from the Token contract to the CorePool.
		expect(await token.balanceOf(user0.address)).to.equal(userBalances[0].sub(amount));
		expect(await corePool.getDepositsLength(user0.address)).to.equal(1);

		// Now attempt to withdraw it.
		await expect(
			corePool.connect(user0).unstake(parseEther('0'), parseEther('100'), rolloverInvestment)
		).to.be.revertedWith('deposit not yet unlocked');
		// Wait for less than a 28 days and expect failure.
		await fastForward(fromTimestampBN(lockUntil.sub(MINUTE / MILLIS)));
		// Before unstake executes the user should have the previous balances.
		expect(await token.balanceOf(user0.address)).to.equal(userBalances[0].sub(amount));
		expect(await escrowToken.balanceOf(user0.address)).to.equal(userEscrowBalance[0]);
		await expect(
			corePool.connect(user0).unstake(0, amount.div(2), rolloverInvestment)
		).to.be.revertedWith('deposit not yet unlocked');

		// Wait a little longer though
		await fastForward(fromTimestampBN(lockUntil.add(MINUTE / MILLIS)));
		// Before unstake executes the user should have the previous balances.
		expect(await token.balanceOf(user0.address)).to.equal(userBalances[0].sub(amount));
		expect(await escrowToken.balanceOf(user0.address)).to.equal(userEscrowBalance[0]);
		await corePool.connect(user0).unstake(0, amount.div(2), rolloverInvestment);

		//
		expect(await corePool.getDepositsLength(user0.address)).to.equal(2);

		// Examine the tokens this address now owns.
		expect(await token.balanceOf(user0.address)).to.equal(userBalances[0].sub(amount.div(2)));
		expect(await escrowToken.balanceOf(user0.address)).to.equal(userEscrowBalance[0]);

		// Is there a new Deposit?
		expect(await corePool.getDepositsLength(user0.address)).to.equal(2);
		// DEPOSIT 0 (initial)
		[
			tokenAmount, // @dev token amount staked
			weight, //      @dev stake weight
			lockedFrom, //  @dev locking period - from
			lockedUntil, // @dev locking period - until
			isYield, //     @dev indicates if the stake was created as a yield reward
		] = await corePool.getDeposit(user0.address, 0);
		expect(tokenAmount).to.equal(amount.div(2));
		expect(weight.eq(parseEther('559890240')));
		expect(lockedUntil).to.equal(lockUntil);
		expect(isYield).to.equal(false);

		await corePool
			.connect(user0)
			.updateStakeLock(0, lockedUntil.add((2 * DAY) / MILLIS), rolloverInvestment);

		lastLocked = lockedUntil;
		let nextRewardTime: Date = fromTimestampBN(lockedUntil.add((2 * DAY + 2 * MINUTE) / MILLIS));

		expect(lastLocked).to.equal(lockUntil);

		lastLocked = lockedUntil;
		let reward1Amount = tokenAmount;

		// Wait a until the FIRST deposit is unlocked to claim it.
		await fastForward(nextRewardTime);
		// Get the SECOND deposit's unlock time.
		nextRewardTime = fromTimestampBN(lockedUntil.add((65 * MINUTE) / MILLIS));

		await corePool.connect(user0).processRewards(rolloverInvestment);
		expect(await corePool.getDepositsLength(user0.address)).to.equal(4);
		// DEPOSIT 0 (first)
		[
			tokenAmount, // @dev token amount staked
			weight, //      @dev stake weight
			lockedFrom, //  @dev locking period - from
			lockedUntil, // @dev locking period - until
			isYield, //     @dev indicates if the stake was created as a yield reward
		] = await corePool.getDeposit(user0.address, 0);
		expect(tokenAmount.eq(parseEther('52'))); // first rewards
		expect(weight.eq(parseEther('55989024'))); // Weight stayed the same.
		expect(lockedUntil == lastLocked); // Rewards are locked until the same time as Deposit 0.
		expect(isYield).to.equal(false); //NB: this flag was set to true.

		// Before unstaking the first deposit executes the user should have the previous balances.
		expect(await token.balanceOf(user0.address)).to.equal(userBalances[0].sub(amount.div(2)));
		expect(await escrowToken.balanceOf(user0.address)).to.equal(userEscrowBalance[0]);
		// Unstake whatever remains of that first deposit.
		await corePool.connect(user0).unstake(0, amount.div(2), rolloverInvestment);
		// After unstaking the remainder of the first deposit user should have the previous balances.
		expect(await token.balanceOf(user0.address)).to.equal(userBalances[0]);
		expect(await escrowToken.balanceOf(user0.address)).to.equal(userEscrowBalance[0]);

		// Yet another Deposit is created. A much bigger one.
		const maxDeposits = await corePool.getDepositsLength(user0.address);

		// DEPOSIT 0 (first)
		[
			tokenAmount, // @dev token amount staked
			weight, //      @dev stake weight
			lockedFrom, //  @dev locking period - from
			lockedUntil, // @dev locking period - until
			isYield, //     @dev indicates if the stake was created as a yield reward
		] = await corePool.getDeposit(user0.address, 0);
		expect(tokenAmount).to.equal(0); // Done.
		expect(weight).to.equal(0);
		expect(lockedFrom).to.equal(0);
		expect(lockedUntil).to.equal(0);
		expect(isYield).to.equal(false);

		let lastTimestamp = lastLocked;
		let totalRewards = BigNumber.from(0);
		// Let's go grab all those rewards.
		for (let deposit = BigNumber.from(1); deposit.lt(maxDeposits); deposit = deposit.add(1)) {
			//console.log('deposit', deposit.toNumber());
			[
				tokenAmount, // @dev token amount staked
				weight, //      @dev stake weight
				lockedFrom, //  @dev locking period - from
				lockedUntil, // @dev locking period - until
				isYield, //     @dev indicates if the stake was created as a yield reward
			] = await corePool.getDeposit(user0.address, deposit);
			if (lockedUntil > lastTimestamp) {
				// Wait a until the FIRST deposit is unlocked to claim it.
				nextRewardTime = fromTimestampBN(lockedUntil.add(1));
				await fastForward(nextRewardTime);
				lastTimestamp = lockedUntil.add(1);
			}
			// Unstake whatever remains of this deposit.
			await corePool.connect(user0).unstake(deposit, tokenAmount, claimSMODARewards);
			totalRewards = totalRewards.add(tokenAmount);
			expect(await corePool.getDepositsLength(user0.address)).to.equal(maxDeposits);
			[
				tokenAmount, // @dev token amount staked
				weight, //      @dev stake weight
				lockedFrom, //  @dev locking period - from
				lockedUntil, // @dev locking period - until
				isYield, //     @dev indicates if the stake was created as a yield reward
			] = await corePool.getDeposit(user0.address, deposit);
			expect(tokenAmount).to.equal(0); // Done.
			expect(weight).to.equal(0);
			expect(lockedFrom).to.equal(0);
			expect(lockedUntil).to.equal(0);
			expect(isYield).to.equal(false);
		}
		// Before unstaking the first deposit executes the user should have the previous balances.
		const finalTokenBalance = await token.balanceOf(user0.address);
		expect(finalTokenBalance.gt(parseEther('1188496')));
		const finalEscrowBalance = await escrowToken.balanceOf(user0.address);
		expect(finalTokenBalance.gt(parseEther('72769')));
	});
});
