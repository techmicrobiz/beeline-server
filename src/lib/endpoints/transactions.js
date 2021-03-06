/**

This module REQUIRES familiarity with accounting basics, and the
accounting conventions we adopt for Beeline.

Please familiarize yourself with them, or approach someone who
knows what's going on.


**/
import _ from "lodash"
import Joi from "joi"
import assert from "assert"

import {SecurityError, InvalidArgumentError} from '../util/errors'

import {getDB, getModels, defaultErrorHandler, assertFound} from "../util/common"
import * as auth from '../core/auth'
import * as Payment from "../transactions/payment"
import * as events from '../events/events'
import {TransactionBuilder} from '../transactions/builder'

import {
  prepareTicketSale, chargeSale,
  TransactionError, ChargeError, validateTxn,
  checkAvailability, checkValidTrips, checkValidTripStop,
  purchaseRoutePass, prepareTicketRefund, prepareRoutePassRefund
} from "../transactions"

import {routeRequestsTo, handleRequestWith} from "../util/endpoints"

const INVALID_CREDIT_TAGS = [
  'public', 'lite', 'mandai', 'crowdstart',
  'notify-when-empty', 'success', 'failed'
]

export function register (server, options, next) {
  routeRequestsTo(server,
    [
      "/transactions/payment_ticket_sale",
      "/transactions/tickets/payment"
    ],
    {
      method: "POST",
      config: {
        tags: ["api"],
        description:
  `Prepare a transaction with tickets, charge Stripe, and then mark the
  transaction as committed and the tickets as valid if Stripe has been
  successfully charged.`,
        validate: {
          payload: {
            trips: Joi.array().items(Joi.object({
              tripId: Joi.number().integer(),
              // qty: Joi.number().integer().default(1).min(1).max(1),
              boardStopId: Joi.number().integer(),
              alightStopId: Joi.number().integer()
            })),
            promoCode: Joi.object({
              code: Joi.string().allow('').required(),
              options: Joi.object()
            }).allow(null),
            creditTag: Joi.string().optional().allow(null),
            applyRoutePass: Joi.boolean().default(false),
            applyReferralCredits: Joi.boolean().default(false),
            applyCredits: Joi.boolean().default(false),
            stripeToken: Joi.string(),
            customerId: Joi.string(),
            sourceId: Joi.string(),
            expectedPrice: Joi.number().allow(null),
          }
        }
      },
      async handler (request, reply) {
        var db = getDB(request)
        var m = getModels(request)

        try {
          // Add the user id to the trip orders
          if (!options.dryRun && request.auth.credentials.scope !== "user") {
            throw new SecurityError('Need to be logged in to make transaction')
          }
          for (let trip of request.payload.trips) {
            trip.userId = request.auth.credentials.userId
          }

          // check payload has either stripe token or customerId
          if (!request.payload.stripeToken && (!request.payload.customerId || !request.payload.sourceId)) {
            throw new InvalidArgumentError('No stripe token or customerId is provided')
          }

          /* Prepare the transaction */
          let [dbTxn, undoFn] = await prepareTicketSale([db, m], {
            trips: request.payload.trips,
            promoCode: request.payload.promoCode,
            creditTag: request.payload.creditTag,
            applyRoutePass: request.payload.applyRoutePass,
            applyReferralCredits: request.payload.applyReferralCredits,
            applyCredits: request.payload.applyCredits,
            dryRun: false,
            committed: true,
            convertToJson: false,
            expectedPrice: request.payload.expectedPrice,
            creator: {
              type: 'user',
              id: request.auth.credentials.userId
            }
          })

          assert(dbTxn.id)

          var chargeOptions = {
            db, models: m, transaction: dbTxn,
            tokenIat: request.auth.credentials.iat,
            paymentDescription: `[Txn #${dbTxn.id}] ` + dbTxn.description
          }

          if (request.payload.stripeToken) {
            _.assign(chargeOptions, {stripeToken: request.payload.stripeToken})
          } else if (request.payload.customerId && request.payload.sourceId) {
            _.assign(chargeOptions, {
              customerId: request.payload.customerId,
              sourceId: request.payload.sourceId
            })
          }

          // charge stripe
          try {
            await chargeSale(chargeOptions)
          } catch (err) {
            console.log(err)
            if (err instanceof ChargeError) {
              console.error(err.stack)
              try {
                await undoFn()
              } catch (err2) {
                events.emit('transactionFailure', {
                  message: `!!! ERROR UNDOING ${dbTxn.id} with ${err2.message}`,
                  userId: request.auth.credentials.userId
                })
                console.error(err2)
              }
            }
            throw err
          }

          dbTxn = await m.Transaction.findById(dbTxn.id, {
            include: [m.TransactionItem]
          })
          await m.TransactionItem.getAssociatedItems(dbTxn.transactionItems);

          // asynchronously reload the ticket data and run the hooks
          (async function (tis) {
            var ticketIds = tis.filter(ti => ti.ticketSale).map(ti => ti.itemId)

            ticketIds.forEach(async (ticketId) => {
              try {
                let newTicketInst = await m.Ticket.findById(ticketId, {
                  include: [
                    {model: m.TripStop, as: 'boardStop'},
                    {model: m.TripStop, as: 'alightStop'},
                  ]
                })
                let newTicketTrip = await m.Trip.find({
                  include: [
                    {model: m.TripStop, where: {id: newTicketInst.boardStopId}},
                    m.Route
                  ]
                })
                events.emit('newBooking', {trip: newTicketTrip, ticket: newTicketInst})
              } catch (err) {
                console.log(err.stack)
              }
            })
          })(dbTxn.transactionItems)

          let transactionItemsByType = _.groupBy(dbTxn.transactionItems, ti => ti.itemType)
          let numValidPromoTickets = null
          var promotionId = null

          if (transactionItemsByType.discount) {
            let promo = transactionItemsByType.discount.filter(item => item.discount.promotionId)
            assert(promo.length < 2, `Only 1 promotion per purchase is allowed`)
            if (promo.length === 1) {
              promotionId = promo[0].discount.promotionId
              numValidPromoTickets = _.keys(promo[0].notes.tickets)
                .filter(ticketId => promo[0].notes.tickets[ticketId] > 0)
                .length
            }
          }

          events.emit('newPurchase', {
            userId: request.auth.credentials.userId,
            numValidPromoTickets,
            promotionId,
          })

          reply(dbTxn.toJSON())
        } catch (err) {
          events.emit('transactionFailure', {
            message: err.message,
            userId: request.auth.credentials.userId
          })
          defaultErrorHandler(reply)(err)
        }
      }
    }
  )

  routeRequestsTo(server,
    [
      "/transactions/route_passes/payment"
    ],
    {
      method: "POST",
      config: {
        tags: ["api"],
        description:
    `Prepare a transaction with tickets, charge Stripe, and then mark the
    transaction as committed and the tickets as valid if Stripe has been
    successfully charged.`,
        auth: {access: {scope: ["user"]}},
        validate: {
          payload: {
            value: Joi.number().description("The total cash value of the route pass transaction. Use this or quantity, but not both"),
            quantity: Joi.number().description("The number of route passes to purchase. Use this or value, but not both"),
            promoCode: Joi.object().keys({
              code: Joi.string().allow('').required(),
              options: Joi.object()
            }).allow(null)
              .description("For bulk discounts, pass in the promoCode of a promotion with the tiered discount"),
            tag: Joi.string().description("The tag of the route to purchase passes from"),
            creditTag: Joi.string().description("DEPRECATED. The tag of the route to purchase passes from"),
            companyId: Joi.number().integer().min(0).required(),
            applyCredits: Joi.boolean().default(false),
            stripeToken: Joi.string(),
            customerId: Joi.string().description("For payment with saved credit card"),
            sourceId: Joi.string().description("For payment with saved credit card"),
            expectedPrice: Joi.number().allow(null).default(null),
          }
        }
      },
      async handler (request, reply) {
        var db = getDB(request)
        var m = getModels(request)

        try {
          // Check that we can get hold of either stripe token or customerId
          const userId = request.auth.credentials.userId
          const cardDetails = _.pick(request.payload, request.payload.stripeToken ? 'stripeToken' : ['customerId', 'sourceId'])

          InvalidArgumentError.assert(
            cardDetails.stripeToken || (cardDetails.customerId && cardDetails.sourceId),
            'No stripe token or customerId is provided'
          )

          /* Prepare the transaction */
          const [dbTxn, undoFn] = await purchaseRoutePass({
            userId,
            db, models: m,
            promoCode: request.payload.promoCode,
            value: request.payload.value,
            quantity: request.payload.quantity,
            tag: request.payload.tag || request.payload.creditTag,
            companyId: request.payload.companyId,
            expectedPrice: request.payload.expectedPrice
          })

          assert(dbTxn.id)

          var chargeOptions = {
            db, models: m, transaction: dbTxn,
            tokenIat: request.auth.credentials.iat,
            paymentDescription: `[Txn #${dbTxn.id}] ` + dbTxn.description,
            ...cardDetails
          }

          // charge stripe
          try {
            await chargeSale(chargeOptions)
          } catch (err) {
            console.log(err)
            if (err instanceof ChargeError) {
              console.error(err.stack)
              try {
                await undoFn()
              } catch (err2) {
                events.emit('transactionFailure', {
                  message: `!!! ERROR UNDOING ${dbTxn.id} with ${err2.message}`,
                  userId: request.auth.credentials.userId
                })
                console.error(err2)
              }
            }
            throw err
          }

          let transactionItemsByType = _.groupBy(dbTxn.transactionItems, ti => ti.itemType)
          let numValidPromoTickets = null
          var promotionId = null

          if (transactionItemsByType.discount) {
            let promo = transactionItemsByType.discount.filter(item => item.discount.promotionId)
            if (promo.length === 1) {
              promotionId = promo[0].discount.promotionId
              numValidPromoTickets = 1
            }
          }

          events.emit('newPurchase', {
            userId: request.auth.credentials.userId,
            numValidPromoTickets,
            promotionId,
          })

          reply(dbTxn.toJSON())
        } catch (err) {
          events.emit('transactionFailure', {
            message: err.message,
            userId: request.auth.credentials.userId
          })
          defaultErrorHandler(reply)(err)
        }
      }
    })

  routeRequestsTo(server,
    [
      "/transactions/ticket_sale",
      "/transactions/tickets/quote"
    ],
    {
      method: "POST",
      config: {
        tags: ["api"],
        description:
  `Used to preview the result of payment_ticket_sale
  `,
        notes:
  `Payload must have an array \`trips\`, each an object with a \`tripId\`, \`qty\`, \`boardStopId\` and \`alightStopId\`.
  `,
        validate: {
          payload: Joi.object({
            trips: Joi.array().items(Joi.object({
              tripId: Joi.number().integer(),
              // qty: Joi.number().integer().default(1).min(1).max(1),
              boardStopId: Joi.number().integer(),
              alightStopId: Joi.number().integer()
            })),
            creditTag: Joi.string().optional().allow(null),
            applyRoutePass: Joi.boolean().default(false),
            applyReferralCredits: Joi.boolean().default(false),
            applyCredits: Joi.boolean().default(false),
            promoCode: Joi.object().keys({
              code: Joi.string().allow(''),
              options: Joi.object()
            }).allow(null).default(null),
            dryRun: Joi.boolean().default(true)
          }).unknown()
        }
      },

      async handler (request, reply) {
        try {
          assert(request.payload.dryRun, "Prepared ticket transactions are currently not allowed")

          for (let trip of request.payload.trips) {
            trip.userId = request.auth.credentials.userId || 0
          }

          var db = getDB(request)
          var m = getModels(request)
          var [preparedTransaction] = await prepareTicketSale([db, m], {
            trips: request.payload.trips,
            promoCode: request.payload.promoCode,
            creditTag: request.payload.creditTag,
            applyRoutePass: request.payload.applyRoutePass,
            applyReferralCredits: request.payload.applyReferralCredits,
            applyCredits: request.payload.applyCredits,
            dryRun: request.payload.dryRun
          })
          reply(preparedTransaction)
        } catch (err) {
          defaultErrorHandler(reply)(err)
        }
      }
    }
  )

  server.route({
    method: "POST",
    path: '/transactions/route_passes/{routePassId}/refund/payment',
    config: {
      auth: { access: {scope: ["admin", "superadmin"] }},
      tags: ["api"],
      description:
`Perform a stripe refund on unused route passes. Application fees
will not be refunded here, so we will make a net profit.`,
      validate: {
        params: {
          routePassId: Joi.number().integer().min(0).required(),
        },
        payload: {
          transactionItemId: Joi.number().integer().min(0).required(),
        }
      }
    },
    handler: handleRequestWith(
      async (ignored, request, {db, models}) => {
        const transactionItemId = request.payload.transactionItemId
        const routePassId = request.params.routePassId
        const credentials = request.auth.credentials

        // create transaction, relevant transactionItems
        var [txn, undoFn, stripeRefundInfo] = await db.transaction(async transaction => {
          const routePass = await models.RoutePass.findById(routePassId)
          auth.assertAdminRole(credentials, 'refund', routePass.companyId)

          const transactionItem = await models.TransactionItem.findById(transactionItemId)
          return prepareRoutePassRefund({db, models, credentials, transactionItem, routePass})(transaction)
        })
        return {db, txn, undoFn, stripeRefundInfo}
      },
      refundViaStripeWithAccounting
    ),
  })

  // Perform a stripe refund on a ticket
  // Refunds up to the amount paid in the transaction (checked by stripe)
  // or price of the ticket, whichever is lower.
  // @Param: ticketId
  // @Param: targetAmt - for partial refunds. set an amount up to the value of the ticket
  //                                   |     Debit     |  Credit
  // ================================================================
  // ticketRefund                      |      $x       |
  // refundPayment                     |               |    $x
  // account (Upstream Refunds)        |               | $x + stripe
  // transfer                          |    stripe     |
  // transfer                          |      $x       |
  routeRequestsTo(server,
    [
      {
        path: "/transactions/tickets/{ticketId}/refund/payment",
        config: {
          validate: {
            params: {
              ticketId: Joi.number().integer().min(0).required(),
            },
            payload: Joi.object({
              targetAmt: Joi.number().min(0).required(),
            })
          }
        }
      }
    ],
    {
      method: "POST",
      config: {
        auth: { access: {scope: ["admin", "superadmin", "test"] }},
        tags: ["api"],
        description:
  `Perform a stripe refund on a ticket. Application fees
  will not be refunded here, so we will make a net profit.`,
      },
      handler: handleRequestWith(
        async (ignored, request, {db, models}) => {
          const targetAmt = request.payload.targetAmt
          const ticketId = request.params.ticketId || request.payload.ticketId
          var credentials = request.auth.credentials

          // create transaction, relevant transactionItems
          var [txn, undoFn, stripeRefundInfo] = await prepareTicketRefund({db, m: models, ticketId, targetAmt, credentials})
          return {db, txn, undoFn, stripeRefundInfo}
        },
        refundViaStripeWithAccounting
      ),
    }
  )

  async function refundViaStripeWithAccounting ({db, txn, undoFn, stripeRefundInfo}, request) {
    try {
      var tiByTypes = _.groupBy(txn.transactionItems, ti => ti.itemType)
      let {charge, amount, idempotencyKey} = stripeRefundInfo
      let refundAmtCents = Math.round(amount * 100)

      try {
        var stripeRefundResult = await Payment.refundCharge(charge.id, refundAmtCents / 100, idempotencyKey)

        assert(stripeRefundResult.status === 'succeeded', 'Stripe refund was not performed')
      } catch (err) {
        let refundPaymentInst = tiByTypes.refundPayment[0].refundPayment
        await refundPaymentInst.update({ data: err })

        throw new ChargeError(err.message)
      }

      // fill out refundPayment
      await db.transaction(async (transaction) => {
        assert.strictEqual(tiByTypes.refundPayment.length, 1)

        let refundPaymentInst = tiByTypes.refundPayment[0].refundPayment
        await refundPaymentInst.update({
          paymentResource: stripeRefundResult.id,
          data: stripeRefundResult
        })

        // amend processing fee:
        let processingFee = -(await Payment.retrieveTransaction(
          stripeRefundResult.balance_transaction
        )).fee / 100

        // for stripe-transfer (processing fee)
        let stripeTransfer = tiByTypes.transfer.find(ti =>
          ti.transfer.thirdParty === "stripe"
        )
        await stripeTransfer.update({debit: processingFee}, {transaction})
        await stripeTransfer.transfer.update({incoming: processingFee}, {transaction})

        // for account transaction item
        assert.strictEqual(tiByTypes.account.length, 1)
        await tiByTypes.account[0].update({credit: amount + processingFee}, {transaction})
      })

      return txn.toJSON()
    } catch (err) {
      if (err instanceof ChargeError) {
        console.log(err)
        try {
          await undoFn()
        } catch (err2) {
          console.log(err2)
          events.emit('transactionFailure', {
            message: `Error performing refund. ${err.message}`,
            userId: request.auth.credentials.adminId || request.auth.credentials.email,
          })
        }
      }

      throw err
    }
  }

  // Refunds a ticket, issuing a routePass in its stead
  // Current implementation of routePass requires the relevant
  //   route credits account to have a balance equal to some
  //   multiple of the route's prices, thus amount refunded
  //   has to equal to the ticket's base value, regardless
  //   of discounts
  // Correspondingly, partially refunded tickets cannot be
  //   refunded through this endpoint
  // @Param: ticketId
  // @Param: targetAmt
  //                                   |  Debit   |  Credit
  // =======================================================
  // ticketRefund                      |   $x     |
  // routePass                         |          |    $x
  // account (Upstream Refunds)        |          |    $x
  // account (COGS)                    |   $x     |
  routeRequestsTo(server,
    [
      {
        path: "/transactions/tickets/{ticketId}/refund/route_pass",
        config: {
          validate: {
            params: {
              ticketId: Joi.number().integer().min(0).required(),
            },
            payload: Joi.object({
              targetAmt: Joi.number().min(0).required(),
              creditTag: Joi.string().disallow(INVALID_CREDIT_TAGS).required()
            })
          }
        }
      }
    ],
    {
      method: "POST",
      config: {
        auth: { access: {scope: ["admin", "superadmin", "test"] }},
        tags: ["api"],
        description: `Refund a ticket to routePass`,
        validate: {},
      }, async handler (request, reply) {
        var db = getDB(request)
        var m = getModels(request)
        var {targetAmt, creditTag} = request.payload
        const ticketId = request.params.ticketId || request.payload.ticketId

        try {
          var txn = await db.transaction(async (t) => {
            // ensure that all tickets are valid
            var ticket = await m.Ticket.findById(ticketId, {
              include: [{
                as: "boardStop",
                model: m.TripStop,
                include: [m.Trip],
              }],
              transaction: t
            })

            let route = await m.Route.findById(ticket.boardStop.trip.routeId, {
              attributes: ['id', 'tags'],
              transaction: t,
            })

            const tags = _.difference(route.tags, INVALID_CREDIT_TAGS)

            TransactionError.assert(
              tags.includes(creditTag),
              'The tag provided does not belong to the selected route'
            )

            // check if ticket is eligible for refunds
            TransactionError.assert(ticket.status === 'valid' || ticket.status === 'void',
              "Trying to refund a non-valid ticket")

            // Find the associated company, check if user is authorised to trigger refund
            var [company] = await db.query(`
              SELECT "transportCompanies"."id"
              FROM tickets
                INNER JOIN "tripStops"
                  ON "tickets"."boardStopId" = "tripStops"."id"
                INNER JOIN "trips"
                  ON "tripStops"."tripId" = "trips".id
                INNER JOIN "routes"
                  ON "trips"."routeId" = "routes".id
                INNER JOIN "transportCompanies"
                  ON "transportCompanies"."id" = "routes"."transportCompanyId"
              WHERE "tickets"."id" = :ticketId
            `,
              {
                transaction: t,
                type: db.QueryTypes.SELECT,
                replacements: {
                  ticketId: ticket.id
                }
              }
            )
            auth.assertAdminRole(request.auth.credentials, 'refund', company.id)

            // Reverse search from ticket id, get transaction entry + related transactionItems
            var ticketSale = await m.TransactionItem.find({
              where: {
                itemId: ticket.id,
                itemType: 'ticketSale'
              },
              include: [{
                model: m.Transaction,
                include: [m.TransactionItem]
              }],
              transaction: t
            })

            TransactionError.assert(ticketSale, 'Cannot refund/void a ticket that was not sold - ticketSale not found')

            // Check for previous partial refunds for this ticket
            var refundTI = await m.TransactionItem.findAll({
              where: {
                itemId: ticket.id,
                itemType: 'ticketRefund'
              },
              include: [{
                model: m.Transaction,
                where: {committed: true},
                attributes: [],
              }],
              attributes: ['debit'],
              transaction: t
            })

            const previouslyRefunded = _.sum(refundTI.map(ti => ti.debit))

            const price = +ticketSale.credit

            // Current form of routePass only works if route credits
            // owned by user are multiples of a ticket's base price
            // Thus, value of refund has to be equal to the base price of ticket
            TransactionError.assert(Math.abs(targetAmt - price) < 0.0001,
              `Route Pass requires refunded amount to be equal to ticket's base price`)

            TransactionError.assert(previouslyRefunded === 0,
              'Unable to refund to routePass for partially refunded tickets')

            let transactionBuilder = new TransactionBuilder({
              db, models: m, transaction: t, dryRun: false,
              committed: true,
              creator: {
                type: request.auth.credentials.scope,
                id: request.auth.credentials.adminId || request.auth.credentials.email
              },
            })

            transactionBuilder.postTransactionHooks.push(transactionBuilder._saveChangesToTickets)

            transactionBuilder.transactionItemsByType.ticketRefund = [{
              itemType: 'ticketRefund',
              itemId: ticket.id,
              debit: targetAmt
            }]

            transactionBuilder.description = `Refund to RoutePass for ticket ${ticket.id}`

            ticket = await ticket.update({status: 'void'}, {transaction: t})

            transactionBuilder.undoFunctions.push(
              (t) => ticket.update({status: 'valid'}, {transaction: t})
            )

            transactionBuilder = await m.RoutePass.refundFromTicket(transactionBuilder,
              ticketSale, company.id, ticket.userId, creditTag)

            const [dbTransactionInstance] = await transactionBuilder.build({type: 'refundToRoutePass'})

            return dbTransactionInstance
          })

          reply(txn.toJSON())
        } catch (err) {
          events.emit('transactionFailure', {
            message: `Error performing refund ${err.message}`,
            userId: request.auth.credentials.adminId || request.auth.credentials.email,
          })
          defaultErrorHandler(reply)(err)
        }
      }
    }
  )

  // Issue a free route pass to a user's account
  // Assumption that companies are bearing costs for this
  // Parameters:
  // - userId: user to give route passes to
  // - numPasses: number of route passes to issue.
  // - routeId: route to issue routePasses for
  // - description: reason for free route pass
  //                                   |  Debit   |  Credit
  // =======================================================
  // routePass                         |          |    $x
  // account (Upstream Route Credits)  |   $x     |
  routeRequestsTo(server,
    [
      '/transactions/route_passes/issue_free'
    ],
    {
      method: "POST",
      config: {
        auth: { access: {scope: ["admin", "superadmin"] }},
        tags: ["api"],
        description: 'Issue free route passes to User',
        validate: {
          payload: Joi.object({
            userId: Joi.number().integer().min(0).required(),
            routeId: Joi.number().integer().description('DEPRECATED: Use tag to look up a route'),
            quantity: Joi.number().integer().min(1).default(1),
            tag: Joi.string().disallow(INVALID_CREDIT_TAGS).required(),
            description: Joi.string().optional(),
          })
        }
      },
      async handler (request, reply) {
        try {
          let db = getDB(request)
          let m = getModels(request)

          let txnInfo = await db.transaction(async (transaction) => {
            const { userId, description, quantity, tag } = request.payload
            const { scope: authScope, adminId, email: adminEmail } = request.auth.credentials
            let userInst = await m.User.findById(userId, {transaction})
            assertFound(userInst, 'User specified not found')

            // retrieve and identify tag to add credits to
            let routeInst = await m.Route.find({
              where: {
                tags: {$contains: [tag]}
              },
              attributes: ['id', 'tags', 'transportCompanyId'],
              transaction,
            })

            assertFound(routeInst, 'Route specified not found')

            // check if requester is allowed to issue credits for this route
            auth.assertAdminRole(request.auth.credentials, 'issue-tickets',
              routeInst.transportCompanyId, 'This route does not belong to your company')

            const indicativeTrip = await m.IndicativeTrip.findById(routeInst.id)
            const amount = indicativeTrip.nextPrice

            // create transaction and transactionItems
            const transactionData = {
              type: 'freeRoutePass',
              transactionItems: [],
              committed: true,
              description,
              creatorType: authScope,
              creatorId: (authScope === 'admin')
                ? adminId
                : (authScope === 'superadmin')
                  ? adminEmail : null,
            }

            await Promise.all(_.range(0, quantity).map(async () => {
              const routePass = await m.RoutePass.create( // eslint-disable-line no-await-in-loop
                {userId, companyId: routeInst.transportCompanyId, tag, status: 'valid', notes: { price: amount }},
                {transaction}
              )

              let routePassTransactionItem = {
                itemType: 'routePass',
                itemId: routePass.id,
                credit: amount,
                notes: null,
              }

              transactionData.transactionItems.push(routePassTransactionItem)
            }))

            let accountInst = await m.Account.getByName(
              'Upstream Route Credits', {transaction}
            )
            let accountTransactionItem = {
              itemType: 'account',
              itemId: accountInst.id,
              debit: amount * quantity,
              notes: { transportCompanyId: routeInst.transportCompanyId },
            }

            transactionData.transactionItems.push(accountTransactionItem)

            var transactionInstance = await m.Transaction
              .create(transactionData, {
                transaction,
                include: m.Transaction.allTransactionTypes(),
              })

            return transactionInstance
          })

          reply(txnInfo.toJSON())
        } catch (err) {
          defaultErrorHandler(reply)(err)
        }
      }
    }
  )

  /*
              DEBIT     CREDIT
  Ticket (as expense):         0.00
  COGS:          0.00

  */
  routeRequestsTo(server,
    [
      "/transactions/tickets/issue_free"
    ],
    {
      method: "POST",
      config: {
        auth: { access: { scope: ["admin", "superadmin"] }},
        tags: ["api"],
        description: "Issue a free ticket",
        validate: {
          payload: Joi.object({
            description: Joi.string(),

            trips: Joi.array().items(Joi.object({
              boardStopId: Joi.number().integer().required(),
              alightStopId: Joi.number().integer().required(),
              tripId: Joi.number().integer().required(),
              userId: Joi.number().integer().required(),
            })).min(1).required(),


            cancelledTicketIds: Joi.array().items(Joi.number().integer())
              .optional()
              .description(
                `The ticket id of the cancelled ticket(s). If specified, this
                ticket must be valid during the operation. After the operation
                this ticket will be set to "cancelled". A line item will
                be added to invalidate this ticket.`),
          }).unknown()
        }
      },
      async handler (request, reply) {
        try {
          var db = getDB(request)
          var m = getModels(request)

          var txnInfo = await db.transaction({
            isolationLevel: db.Transaction.ISOLATION_LEVELS.SERIALIZABLE
          }, async (t) => {
            var tripIds = request.payload.trips.map(t => t.tripId)

            // Get the trips
            var tripsById = await m.Trip.getForTransactionChecks({
              tripIds: tripIds,
              transaction: t,
            })

            // Ensure that the admin is allowed to issue tickets
            Object.keys(tripsById)
              .map(tripId => parseInt(tripId))
              .forEach(tripId => {
                auth.assertAdminRole(request.auth.credentials, 'issue-tickets',
                  tripsById[tripId].route.transportCompanyId,
                  'The ticket issued does not belong to your company')
              })

            // Run the checks
            var checks = [checkValidTripStop]

            // TODO: should warn if user already has a ticket
            checkValidTrips(tripsById, request.payload.trips, checks)

            // Construct the transaction object
            var transactionData = {
              transactionItems: [],
              committed: true,
              description: request.payload.description,
              creatorType: request.auth.credentials.scope,
              creatorId: (request.auth.credentials.scope === 'admin') ? request.auth.credentials.adminId
                : (request.auth.credentials.scope === 'superadmin') ? request.auth.credentials.email
                  : null,
            }

            // insert the transaction items
            // track refunds so they can be run as one Promise.all([...])
            for (let tripRequest of request.payload.trips) {
              transactionData.transactionItems.push({
                itemType: 'ticketExpense',
                ticketExpense: {
                  boardStopId: tripRequest.boardStopId,
                  alightStopId: tripRequest.alightStopId,
                  userId: tripRequest.userId,
                  status: 'valid'
                },
                credit: 0,
              })
            }

            if (request.payload.cancelledTicketIds) {
              // get the refund tickets
              const refundTickets = await m.Ticket.findAll({
                where: { id: { $in: _.uniq(request.payload.cancelledTicketIds) } },
                transaction: t,
                include: [{
                  model: m.TripStop,
                  as: 'boardStop',
                  include: [{
                    model: m.Trip,
                    include: [{
                      model: m.Route,
                      attributes: ['transportCompanyId'],
                    }]
                  }],
                }]
              })

              await Promise.all(refundTickets.map(async refundTicket => {
                // ensure either superadmin, or same company
                auth.assertAdminRole(request.auth.credentials, 'issue-tickets',
                  refundTicket.boardStop.trip.route.transportCompanyId, true,
                  "The ticket being cancelled does not belong to your company")

                // ensure that the ticket is currently valid
                if (refundTicket.status !== 'valid') {
                  throw new TransactionError(`The ticket being cancelled is not 'valid', but '${refundTicket.status}'`)
                }

                // add a line item
                transactionData.transactionItems.push({
                  itemType: 'ticketRefund',
                  itemId: refundTicket.id,
                  credit: 0,
                })

                return refundTicket.update({status: 'void'}, {transaction: t})
              }))
            }

            var cogsAccount = await m.Account.getByName('Cost of Goods Sold', {
              transaction: t
            })
            transactionData.transactionItems.push({
              itemType: 'account',
              itemId: cogsAccount.id,
            })

            // build the transaction
            var transactionInstance = await m.Transaction
              .create(transactionData, {
                transaction: t,
                include: m.Transaction.allTransactionTypes(),
              })

            await checkAvailability([db, m], tripIds, t)
            await validateTxn(transactionInstance)

            return transactionInstance
          }) /* db.transaction( , async () => {...}) */

          reply(txnInfo.toJSON())
        } catch (err) {
          defaultErrorHandler(reply)(err)
        }
      }
    }
  )

  server.route({
    method: "GET",
    path: "/transactions/check",
    config: {
      auth: { access: { scope: ["superadmin"] }},
      tags: ["api"],
      description:
`Checks all transactions in the database for validity (think of
it as fsck for transactions)`
    },
    async handler (request, reply) {
      try {
        var m = getModels(request)
        var allTransactions = await m.Transaction.findAll({include: [m.TransactionItem]})
        /* Convert each transaction to
          FALSE: if there is no error
          <String>: String describing the error */
        var txnIds = allTransactions.map((txn) => `Transaction #${txn.id}`)
        var errors = allTransactions.map((txn) => {
          if (txn.transactionItems.length <= 1) {
            return "Transactions should have at least two items"
          } else if (_.sumBy(txn.transactionItems, "debitF")) {
            return "Transaction not balanced"
          } else {
            return false
          }
        })

        var paired = _.zip(txnIds, errors).filter((a) => a[1])

        // Check that all valid tickets have an associated transaction item
        var allTickets = await m.Ticket.findAll({
          where: {
            status: "valid"
          },
          include: [
            {
              model: m.TransactionItem,
              required: false,
              where: {
                itemType: {
                  $like: "ticket%"
                }
              },
              include: [{
                model: m.Transaction,
                required: false
              }]
            }
          ]
        })

        var ticketErrors = allTickets.map(ticket => {
          var error = false

          if (ticket.transactionItem == null ||
            ticket.transactionItem.transaction == null) {
            error = "No associated transaction"
          } else if (!ticket.transactionItem.transaction.committed) {
            error = "Valid ticket but transaction not committed!"
          }

          return [`Ticket ${ticket.id}`, error]
        }).filter(x => x[1])

        reply(paired.concat(ticketErrors))
      } catch (err) {
        defaultErrorHandler(reply)(err)
      }
    }
  })

  routeRequestsTo(server, ["/transactions/userHistory", "/transactions/user_history"], {
    method: "GET",
    config: {
      tags: ["api"],
      description:
`Returns a users transaction history (all tickets bought,
refunded, issued)`,
      auth: { access: { scope: ["user"] }},
      validate: {
        query: {
          startTime: Joi.date().default(new Date(0)),
          endTime: Joi.date().default(new Date("2060-01-01")), /* Super far into future */
          page: Joi.number().integer().default(1).min(1),
          perPage: Joi.number().integer().default(20).min(1).max(100)
        }
      }
    },
    async handler (request, reply) {
      try {
        var db = getDB(request)
        var m = getModels(request)

        /*
        1. Find a list of *valid* tickets belonging to user
        2. Find the associated transactions
        3. Show the discounts and payments relating to those transactions
        */
        var ticketIncludes = {
          include: [
            {model: m.TripStop, as: "boardStop", include: [m.Stop, m.Trip]},
            {model: m.TripStop, as: "alightStop", include: [m.Stop]}
          ]
        }

        // var ticketStatuses = ["valid", "refunded"];
        var ticketTypes = ["ticketSale", "ticketExpense", "ticketRefund"]

        // for null, we will assume them as ticketPurchase
        const transactionTypes = ["conversion", "routePassPurchase", "routeCreditPurchase", "routeCreditExpiry", "ticketPurchase", "refundPayment"]

        /* Find list of valid tickets belonging to user, limting transaction type to
        transactionTypes or null, with a limit on the
        number of results */
        var transactionItems = await db.query(`
WITH related_transaction_items AS
  (SELECT
      "transactionItems".*
   FROM
      "transactionItems" INNER JOIN "tickets"
      ON ("transactionItems"."itemType" IN (:ticketTypes)
        AND "transactionItems"."itemId" = tickets.id
        AND "tickets"."userId" = :userId)
   UNION
   SELECT "transactionItems".*
   FROM
      "transactionItems" INNER JOIN "routeCredits"
      ON ("transactionItems"."itemType" = 'routeCredits'
        AND "transactionItems"."itemId" = "routeCredits"."id"
        AND "routeCredits"."userId" = :userId)
   UNION
   SELECT "transactionItems".*
   FROM
      "transactionItems" INNER JOIN "routePasses"
      ON ("transactionItems"."itemType" = 'routePass'
        AND "transactionItems"."itemId" = "routePasses"."id"
        AND "routePasses"."userId" = :userId)
  )
SELECT DISTINCT
  transactions.id
FROM
  transactions
  INNER JOIN related_transaction_items
    ON transactions.id = related_transaction_items."transactionId"
WHERE "transactions"."type" IN(:transactionTypes) OR "transactions"."type" IS NULL
ORDER BY transactions.id DESC
LIMIT :limit
OFFSET :offset
          `, {
            replacements: {
              ticketTypes: ticketTypes,
              userId: request.auth.credentials.userId,
              limit: request.query.perPage,
              offset: request.query.perPage * (request.query.page - 1),
              transactionTypes: transactionTypes
            },
            type: db.QueryTypes.SELECT
          })
        var transactionIds = transactionItems.map(t => t.id)

        var transactions = await m.Transaction.findAll({
          where: {
            id: {
              $in: transactionIds
            }
          },
          order: [["createdAt", "DESC"]],
          include: [{
            model: m.TransactionItem
          }]
        })
        await m.TransactionItem.getAssociatedItems(
          _.flatten(_.map(transactions, "transactionItems")), {
            ticketSale: ticketIncludes,
            ticketRefund: ticketIncludes,
            ticketExpense: ticketIncludes,
          })
        reply({
          transactions: transactions.map(tx => tx.toJSON()),
          page: request.query.page,
          perPage: request.query.perPage,
        })
      } catch (err) {
        return defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "GET",
    path: "/transactions",
    config: {
      tags: ["api"],
      description: "Returns all transactions",
      auth: { access: { scope: ['superadmin', 'admin'] }},
      validate: {
        query: {
          startTime: Joi.date().default(new Date(0)),
          endTime: Joi.date().default(new Date("2060-01-01")), /* Super far into future */
          include: Joi.array().items(
            Joi.string().valid([
              'ticketRefund',
              'ticketSale',
              'ticketExpense',
              'payment',
              'refundPayment',
              'account',
              'transfer',
            ])
          ).default(["*"]),
          page: Joi.number().integer().default(1).min(1),
          perPage: Joi.number().integer().default(20).min(1).max(100)
        }
      }
    },
    async handler (request, reply) {
      try {
        var db = getDB(request)
        var m = getModels(request)

        /*
        Return all transactions, subject to the date/time restrictions
        and include restrictions.
        */
        var searchOptions = {
          where: {},
          include: [{model: m.TransactionItem, include: [], separate: true}]
        }

        searchOptions.where.createdAt = {
          $gte: request.query.startTime,
          $lt: request.query.endTime
        }
        searchOptions.where.committed = true
        searchOptions.offset = (request.query.page - 1) * request.query.perPage
        searchOptions.limit = request.query.perPage
        searchOptions.order = [
          ["createdAt", "DESC"],
          // [m.TransactionItem, "id", "ASC"] // order by child not available when separate = true
        ]

        var companyIds = await auth.getCompaniesByRole(request.auth.credentials, 'view-transactions')

        // if user is a mere admin, restrict displayed transactions to
        // those with his company
        if (request.auth.credentials.scope === 'admin') {
          var ticketTypes = ["ticketSale", "ticketExpense", "ticketRefund"]

          var transactionIds = await db.query(`
  WITH related_transaction_items AS
    (SELECT
      "transactionItems".*
    FROM
      "transactionItems" INNER JOIN "tickets"
      ON "transactionItems"."itemType" IN (:ticketTypes)
      AND "transactionItems"."itemId" = tickets.id
      AND "tickets"."boardStopId" IN
        (SELECT "tripStops"."id"
          FROM "tripStops"
          INNER JOIN "trips" ON "tripStops"."tripId" = "trips"."id"
          INNER JOIN "routes" ON "trips"."routeId" = "routes"."id"
          WHERE "routes"."transportCompanyId" IN(:companyIds))
    )
  SELECT DISTINCT
    transactions.id
  FROM
    transactions
    INNER JOIN related_transaction_items
      ON transactions.id = related_transaction_items."transactionId"
  ORDER BY transactions.id DESC
  LIMIT :limit
  OFFSET :offset
            `, {
              replacements: {
                ticketTypes: ticketTypes,
                companyIds: companyIds,
                limit: request.query.perPage,
                offset: request.query.perPage * (request.query.page - 1)
              },
              type: db.QueryTypes.SELECT
            })
          transactionIds = transactionIds.map(t => t.id)

          searchOptions.where.id = {$in: transactionIds}
        }

        var {count, rows} = await m.Transaction.findAndCountAll(searchOptions)

        // Pull in the associated items
        var ticketIncludes = [
          {
            model: m.TripStop,
            as: "boardStop",
            include: [
              m.Stop,
              { model: m.Trip }
            ],
          },
          {model: m.TripStop, as: "alightStop", include: [m.Stop]},
          {model: m.User, attributes: ["email", "name", "telephone"]}
        ]
        var transactionItems = _.flatten(rows.map(txn => txn.transactionItems))
        await m.TransactionItem.getAssociatedItems(transactionItems, {
          ticketSale: { include: ticketIncludes },
          ticketRefund: { include: ticketIncludes },
          ticketModel: { include: ticketIncludes },
        }, {})

        // FIXME: Use the include=? param to hide certain classes
        // of transaction items

        reply({
          pageCount: Math.ceil(count / request.query.perPage),
          currentPage: request.query.page,
          transactions: rows.map(tx => tx.toJSON())
        })
      } catch (err) {
        return defaultErrorHandler(reply)(err)
      }
    }
  })

  server.route({
    method: "GET",
    path: "/stripe-key",
    config: {
      tags: ["api"],
      description: "The stripe token for transactions"
    },
    handler (request, reply) {
      reply({
        publicKey: Payment.publicKey
      })
    }
  })

  next()
}
register.attributes = {
  name: "endpoint-transactions"
}

// FIXME move to dbschema/scope
export var transactionTypeMap = (m) => {
  var ticketIncludes = [
    {
      model: m.TripStop,
      as: "boardStop",
      include: [
        m.Stop,
        { model: m.Trip }
      ],
    },
    {model: m.TripStop, as: "alightStop", include: [m.Stop]},
    {model: m.User, attributes: ["email", "name", "telephone"]}
  ]

  return {
    "tickets": [
      // {
      //   model: m.Ticket,
      //   as: "ticketSale",
      //   include: ticketIncludes
      // },
      {
        model: m.Ticket,
        as: "ticketExpense",
        include: ticketIncludes,
      },
      {
        model: m.Ticket,
        as: "ticketRefund",
        include: ticketIncludes,
      }
    ],
    "payments": [
      // {model: m.RefundPayment, as: "refundPayment"},
      // {model: m.Payment, as: "payment"}
    ],
    "transfers": [
      // {model: m.Transfer, as: "transfer"}
    ],
    "accounts": [
      // {model: m.Account, as: "account"}
    ]
    // FIXME: discounts, vouchers
  }
}
