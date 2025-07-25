import { CheckoutSelectors, CustomError } from '@bigcommerce/checkout-sdk';
import { createSelector } from 'reselect';

import { CheckoutContextProps } from '@bigcommerce/checkout/payment-integration-api';

import { EMPTY_ARRAY, isExperimentEnabled } from '../common/utility';

import { WithCheckoutProps as BaseWithCheckoutProps } from './Checkout';
import getCheckoutStepStatuses from './getCheckoutStepStatuses';

export interface WithCheckoutProps extends BaseWithCheckoutProps {
    applyCoupon(couponCode: string): Promise<any>;
    removeCoupon(couponCode: string): Promise<any>;
}

export default function mapToCheckoutProps({
    checkoutService,
    checkoutState,
}: CheckoutContextProps): WithCheckoutProps {
    const { data, errors, statuses } = checkoutState;
    const { promotions = EMPTY_ARRAY } = data.getCheckout() || {};
    const submitOrderError = errors.getSubmitOrderError() as CustomError;
    const {
        checkoutSettings: {
            guestCheckoutEnabled: isGuestEnabled = false,
            checkoutUserExperienceSettings = {
                walletButtonsOnTop: false,
                floatingLabelEnabled: false,
            },
        } = {},
        links: {
            loginLink: loginUrl = '',
            createAccountLink: createAccountUrl = '',
            cartLink: cartUrl = '',
        } = {},
        displaySettings: { hidePriceFromGuests: isPriceHiddenFromGuests = false } = {},
    } = data.getConfig() || {};

    const subscribeToConsignmentsSelector = createSelector(
        ({ checkoutService: { subscribe } }: CheckoutContextProps) => subscribe,
        (subscribe) => (subscriber: (state: CheckoutSelectors) => void) => {
            return subscribe(subscriber, ({ data: { getConsignments } }) => getConsignments());
        },
    );

    const walletButtonsOnTopFlag = Boolean(checkoutUserExperienceSettings.walletButtonsOnTop); 
    const isShippingDiscountDisplayEnabled = isExperimentEnabled(
        data.getConfig()?.checkoutSettings,
        'PROJECT-6643.enable_shipping_discounts_in_orders',
    );

    return {
        billingAddress: data.getBillingAddress(),
        cart: data.getCart(),
        clearError: checkoutService.clearError,
        consignments: data.getConsignments(),
        hasCartChanged: submitOrderError && submitOrderError.type === 'cart_changed', // TODO: Need to clear the error once it's displayed
        isGuestEnabled,
        isLoadingCheckout: statuses.isLoadingCheckout(),
        isShippingDiscountDisplayEnabled,
        isPending: statuses.isPending(),
        isPriceHiddenFromGuests,
        isShowingWalletButtonsOnTop: walletButtonsOnTopFlag,
        loadCheckout: checkoutService.loadCheckout,
        loadPaymentMethodByIds: checkoutService.loadPaymentMethodByIds,
        loginUrl,
        cartUrl,
        createAccountUrl,
        promotions,
        subscribeToConsignments: subscribeToConsignmentsSelector({
            checkoutService,
            checkoutState,
        }),
        applyCoupon: checkoutService.applyCoupon,
        removeCoupon: checkoutService.removeCoupon,
        steps: data.getCheckout() ? getCheckoutStepStatuses(checkoutState) : EMPTY_ARRAY,
    };
}
