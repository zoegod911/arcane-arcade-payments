import Sequelize from 'sequelize';

import database from '../../src/models';
import BitcoinExternalAPI from '../../utils/BitcoinExternalAPI'
import Coinjs from '../../../vendor/coin';
import CryptoConversion from '../../utils/CryptoConversion';
import BTCTransactionService from '../../services/BTCTransactionService';
import BitcoinAddressService from '../../services/BitcoinAddressService';
import CentralWalletService from '../../services/CentralWalletService';


const process = async (job, done) => {
  console.log('****** SCANNING BTC DEPOSITS ******');
  const btcAPI = new BitcoinExternalAPI('BTC');

  const coins = Coinjs;

  const testMode = ['development', 'test'].indexOf(job.data.env) >= 0;
  if (testMode) coins.setToTestnet();

  const sendToCentral = async (unspentTXs, { id, wif, address, destination_address }, total_amount) => {
    const activeAddress = await CentralWalletService.fetchOrCreateCentralBitcoinAddress();
    const targetAddress = destination_address;

    const miners_fee = 0.00014626;
    let amountToSend = Number((total_amount - miners_fee).toFixed(8));

    if (amountToSend < 0) {
      const miners_fee = 0.00000426;
      amountToSend = Number((total_amount - miners_fee).toFixed(8));
    }

    const platformFee = amountToSend * .10;
    amountToSend -= platformFee

    console.log("======================================")
    console.log(`| Amount to Send: ${amountToSend}     |`)
    console.log(`| Platform fee: ${platformFee}       |`)
    console.log(`| Central Balance: ${activeAddress.balance}       |`)
    console.log("======================================")


    const paymentOutputs = [
      { address: targetAddress, amount: amountToSend },
      { address: activeAddress.address, amount: platformFee },
    ];

    const paymentInputs = unspentTXs.map((unspentTx) => {
      return {
        transaction_id: unspentTx.tx_id,
        transaction_id_n: unspentTx.tx_n,
        transaction_id_script: unspentTx.script
      }
    });

    const newTransaction = {
      paymentInputs: paymentInputs,
      paymentOutputs: paymentOutputs
    };

    console.log(paymentOutputs);
    console.log(paymentInputs);

    const tx = coins.createTransaction(newTransaction);
    const t = coins.transaction().deserialize(tx);
    const signedHex = t.sign(wif);

    if (signedHex) {
      const response = await btcAPI.broadcastTx(signedHex);

      if (!response.error) {

        activeAddress.balance = parseFloat(activeAddress.balance) + parseFloat(platformFee);
        activeAddress.save()

        const transactionAttrs = {
          bitcoin_address_id: id,
          payment_inputs: newTransaction.paymentInputs,
          payment_outputs: newTransaction.paymentOutputs,
          raw_transaction: tx,
          transaction_id: response.tx.hash
        };

        const createdTransaction = await BTCTransactionService.addTransaction(transactionAttrs);

        if (createdTransaction) {
          const userAddress = await BitcoinAddressService.findByAddress(address);

          userAddress.active = false;
          userAddress.balance = 0

          if (userAddress.save()) return true;
        } else {
          throw new Error('Balance has been updated, transaction broadcast, but error saving Transaction to DB...');
        }
      } else {
        let errorMsg = `Error encountered while broadcasting transaction for ${address}`;
        errorMsg += `\n\n Amount: ${total_amount}, signed_hex: ${signedHex} `;
        errorMsg += `\n\n Error Message: ${response.error}`;

        console.log(errorMsg);

        throw new Error(errorMsg)
      }
    } else {
      throw new Error('Error while signing transaction...');
    }
  }

  let currentPercentage = 0.00;

  console.log('*********** CHECKING ADDRESSES **********')
  const addresses = await database.BitcoinAddress.findAll({
    where: {
      active: true,
      central: false
    },
    attributes: ['id', 'address', 'wif', 'deposit_amount', 'destination_address']
  });

  for (let i = 0; i < addresses.length; i++) {
    const percentage = parseFloat((i + 1)) / addresses.length;
    currentPercentage = Number((percentage).toFixed(2)) * 100;

    const currentAddress = addresses[i];
    console.log(`********* CHECKING ADDRESS: ${currentAddress.address}`)
    try {
      const response = await btcAPI.unspentTXs(currentAddress.address);

      if (response.error) {
        console.log(`Error retrieving unspent transactions for address: ${currentAddress.address}`);

        throw new Error(`Error retrieving unspent transactions for address: ${currentAddress.address}`);
      } else if (response.unspents.length == 0) {
        console.log(`No unspent transactions found for: ${currentAddress.address}`)
        console.log(`${currentPercentage}% Completed...\n\n`);

        job.progress(currentPercentage);

        if (currentPercentage == 100) {
          done();

          return;
        } else {
          continue;
        }
      } else {
        console.log('\n\n\n\n\n==============================================================================================================================');
        console.log(`| Found ${response.unspents.length} unspent transactions, worth: ${response.total_amount} BTC for address: ${currentAddress.address} |`);
        console.log('==============================================================================================================================\n\n\n\n\n');


        try {
          console.log(`TOTAL: ${response.total_amount}`);
          console.log(`DEPOSIT AMOUNT: ${currentAddress.deposit_amount}`);
          if (parseFloat(response.total_amount) == currentAddress.deposit_amount) {
            // Mark the address inactive, do not send it anywhere just yet.

            currentAddress.active = false;
            currentAddress.balance = response.total_amount;
            await currentAddress.save();

            console.log("BALANCE SAVED")

            await sendToCentral(response.unspents, currentAddress, parseFloat(response.total_amount));
          } else {
            console.log(`Received coins in incorrect amount. Expected: ${currentAddress.deposit_amount} | Received: ${parseFloat(response.total_amount)}`)
          }
        } catch (e) {
          debugger;
          throw (e);
        }


        console.log(`${currentPercentage}% Completed...\n\n`);
        job.progress(currentPercentage);

        return response;
      }
    } catch (e) {
      console.log(`Error fetching unspent TXs for ${currentAddress.address}: ${e.message} : ${e.stack}`)
    }
  }
}


module.exports = process;
