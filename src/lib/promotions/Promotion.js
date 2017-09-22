import * as ticketDiscountQualifiers from './functions/ticketDiscountQualifiers'
import {discountingFunctions, refundingFunctions} from './functions/discountRefunds'
import Joi from 'joi'
import assert from 'assert'

export class Promotion {

  /**
    * @param params -- the parameters from the database
    * @param connection -- an object exposing {db, models, transaction, dryRUn},
    *   used by the class to get access to the database connection.
    * @param items -- the items generated by the PO, decorated with additional
    *   information, such as trip and price data
    * @param options -- the options provided by the user
    * @param description -- a human description of the promotion
    * @param promotionId -- the id for the Sequelize model of the promotion
    * @param qualifiers -- a set of functions that validate eligibility
    */
  constructor (transactionBuilder, params, options, description, promotionId, qualifiers = ticketDiscountQualifiers) {
    this.params = params
    this.options = options
    this.connection = transactionBuilder.connection
    this.items = transactionBuilder.items
    this.transactionBuilder = transactionBuilder
    this.isInitialized = false
    this.description = description
    this.promotionId = promotionId
    this.qualifiers = qualifiers
  }

  /**
    * Default filter Function. Filters trips by the criteria given in
    * this.params.qualifyingCriteria.
    * Overriding implementations should set `this._filteredItems` to
    * the list of items, and then they should set this.isInitialized to true
    */
  async initialize () {
    const {qualifyingFunctions} = this.qualifiers
    var {qualifyingCriteria} = this.params
    var {items, options} = this

    // Ensure that the params meet the schema
    Joi.assert(qualifyingCriteria, Joi.array().min(1).items(
      Joi.object().keys({
        type: Joi.string().valid(Object.keys(qualifyingFunctions)),
        params: Joi.object()
      })
    ))

    this._filteredItems = await this.params.qualifyingCriteria
      .reduce(async (filteredPromise, criterion) => {
        const filtered = await filteredPromise
        const rule = qualifyingFunctions[criterion.type](criterion.params, this.transactionBuilder)
        return rule(filtered, options)
      }, Promise.resolve(items.filter(it => !it.transactionItem || it.transactionItem.notes.outstanding > 0)))

    this.isInitialized = true
  }

  isQualified (options) {
    assert(this.isInitialized, "Promotions must be initialized before use")
    return this._filteredItems && this._filteredItems.length > 0
  }

  getValidItems () {
    return this._filteredItems
  }

  // exclude tickets already paid for (routePass - outstanding = 0) from further discounts
  // apply usage limit to filtered items - userLimit
  removePaidAndApplyLimits (limit = null) {
    let removedPaid = this._filteredItems.filter(fi => !fi.transactionItem || fi.transactionItem.notes.outstanding > 0)

    return this._filteredItems = removedPaid.slice(0, limit || removedPaid.length)
  }

  /**
    * Default discounting method. Applies discounts by the conditions
    * specified in discountFunction
    */
  computeDiscountsAndRefunds () {
    const {discountFunction, refundFunction} = this.params
    const items = this._filteredItems
    const options = this.options

    Joi.assert(discountFunction, Joi.object().keys({
      type: Joi.string().valid(Object.keys(discountingFunctions)),
      params: Joi.object()
    }))
    const discount = discountingFunctions[discountFunction.type](discountFunction.params)
    const discounts = discount(items, options)
    const refunds = refundingFunctions[refundFunction.type](items, options, discounts)

    return [discounts, refunds]
  }

  /**
    * This method is called from within a transaction after the trips
    * have been filtered, but before the discounts have been computed.
    *
    * e.g. here you can pull the amount of credits available for the user
    */
  async preApplyHooks () {}

  /**
    * This method is called from within a transaction after the discounts
    * have been computed.
    *
    * e.g. here you can reduce the users credits by the amount applied.
    */
  async postApplyHooks () {}

  /**
    * This method is called from within a transaction after the discounts
    * have been computed, and the transaction is *committed*
    *
    * e.g. here you can reduce the users credits by the amount applied.
    */
  async commitHooks () {}

  /**
    @param options
      @prop transaction -- The transaction that is part of the undo
    */
  async undoHooks (options) {}
}