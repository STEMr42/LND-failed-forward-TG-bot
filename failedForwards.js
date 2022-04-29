const lnService = require("ln-service");
const axios = require("axios");
const dotenv = require("dotenv");
dotenv.config({ path: ".env" });

// main method
(async () => {
  try {
    let retry;
    do {
      retry = false;
      // set unauth LND object
      const { lnd } = lnService.unauthenticatedLndGrpc({
        cert: process.env.CERT,
        socket: process.env.SOCKET,
      });
      // get info from lnd
      const walletStatus = await lnService.getWalletStatus({ lnd });
      //is wallet active and RPC ready?
      if (!walletStatus.is_active) {
        retry = true;
        console.log("Wallet RPC not ready, retrying in 30 seconds...");
        await new Promise((resolve) => setTimeout(resolve, 30000));
      }
    } while (retry);

    // set auth LND object
    const { lnd } = lnService.authenticatedLndGrpc({
      cert: process.env.CERT,
      macaroon: process.env.MACAROON,
      socket: process.env.SOCKET,
    });
    // get info from lnd
    const walletInfo = await lnService.getWalletInfo({ lnd });
    console.log(
      "[HTLC Monitor] starting HTLC monitor routing node =>",
      walletInfo.alias
    );

    // activate sub
    const sub = lnService.subscribeToForwards({ lnd });
    //grab forward events
    sub.on("forward", async (forward) => {
      // console.log("[HTLC Monitor] forward =>", forward);

      // catch internal failures
      if (forward.is_failed == true && forward.internal_failure) {
        // get out channel details - pubkey, alias
        let outPubKey = null;
        let outAlias = null;
        if (forward.out_channel) {
          outPubKey = await getPeerKey({
            lnd,
            routerKey: walletInfo.public_key,
            channelID: forward.out_channel,
          });
          // console.log("[HTLC Monitor] out pub key =>", outPubKey);
          outAlias = await getAlias({ lnd, pubKey: outPubKey });
          // console.log("[HTLC Monitor] out alias =>", outAlias);
        }

        // get in channel details - pubkey, alias
        let inPubKey = null;
        let inAlias = null;
        if (forward.in_channel) {
          inPubKey = await getPeerKey({
            lnd,
            routerKey: walletInfo.public_key,
            channelID: forward.in_channel,
          });
          // console.log("[HTLC Monitor] in pub key =>", inPubKey);
          inAlias = await getAlias({ lnd, pubKey: inPubKey });
          // console.log("[HTLC Monitor] in alias =>", inAlias);
        }

        // convert timestamp to local string
        let timestamp = new Date(forward.at);
        timestamp = timestamp.toLocaleString({ hour12: false });

        console.log(
          `[HTLC Monitor] => FAILED HTLC: ${inAlias}->${outAlias} tokens: ${forward.tokens} failure: ${forward.internal_failure} at: ${timestamp}`
        );

        // send message to TG
        if (forward.internal_failure == "INSUFFICIENT_BALANCE") {
          await sendMessage(
            `\u26A1${
              forward.tokens ? forward.tokens.toLocaleString() : null
            } \u203C\uFE0F${
              forward.internal_failure
            }\n\uD83D\uDD00 ${inAlias}<b>\u2192</b>${outAlias}\n\u23F1 ${timestamp}`
          );
        } //end if insufficient balance
      } //end if forward.failed
    });

    // grab error events
    sub.once("error", (error) => {
      // Terminate subscription and restart after a delay
      sub.removeAllListeners();
      console.log("[HTLC Monitor] sub ERROR event", error);
      sendMessage(`\u2049\uFE0F <b>HTLC Monitor</b> => sub ERROR event`);
      return 0;
    });
  } catch (error) {
    console.log("[HTLC Monitor] sub ERROR =>\n", error);
    await sendMessage(`\u2049\uFE0F <b>HTLC Monitor</b> => ERROR`);
  }
})(); //end main method

// send telegram message
async function sendMessage(message) {
  const encodedMessage = encodeURI(message);
  let url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_API_KEY}/sendMessage?chat_id=${process.env.TELEGRAM_CHAT_ID}&text=${encodedMessage}&parse_mode=html`;

  try {
    const response = await axios.get(url, {
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.log("[HTLC Monitor] telegram ERROR", error);
  }
} //end sendMessage

// get peer pub key
async function getPeerKey({ lnd, routerKey, channelID }) {
  try {
    const channel = await lnService.getChannel({
      lnd,
      id: channelID,
    });
    // console.log("[HTLC Monitor] getPeerKey response =>", channel);
    let policies = channel.policies;
    // console.log("[HTLC Monitor] policies =>", policies);
    const localPolicy = policies.filter(
      (policy) => policy.public_key != routerKey
    );
    const peerKey = localPolicy[0].public_key;
    // console.log("[HTLC Monitor] peer key =>", peerKey);
    return peerKey;
  } catch (error) {
    console.log(
      `[HTLC Monitor] ERROR getting peer key for ${channelID} ${error}`
    );
    await sendMessage(
      `\u2049\uFE0F <b>HTLC Monitor</b> => ERROR getting peer key`
    );
    return null;
  }
} //end getPeerKey

// get alias for pub key
async function getAlias({ lnd, pubKey }) {
  try {
    const { alias } = await lnService.getNode({
      lnd,
      public_key: pubKey,
      is_omitting_channels: true,
    });
    return alias;
  } catch (error) {
    console.log(`[HTLC Monitor] ERROR getting alias for ${pubKey} ${error}`);
    await sendMessage(
      `\u2049\uFE0F <b>HTLC Monitor</b> => ERROR getting alias`
    );
    return null;
  }
} //end getAlias
