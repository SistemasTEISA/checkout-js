import {
    Address,
    Cart,
    CartChangedError,
    CheckoutParams,
    CheckoutSelectors,
    Consignment,
    EmbeddedCheckoutMessenger,
    EmbeddedCheckoutMessengerOptions,
    ExtensionRegion,
    FlashMessage,
    PaymentMethod,
    Promotion,
 RequestOptions } from '@bigcommerce/checkout-sdk';
import classNames from 'classnames';
import { find, findIndex } from 'lodash';
import React, { Component, lazy, ReactNode } from 'react';

import { AnalyticsContextProps } from '@bigcommerce/checkout/analytics';
import { Extension, ExtensionContextProps, withExtension } from '@bigcommerce/checkout/checkout-extension';
import { ErrorLogger } from '@bigcommerce/checkout/error-handling-utils';
import { TranslatedString, withLanguage, WithLanguageProps } from '@bigcommerce/checkout/locale';
import {
    AddressFormSkeleton,
    ChecklistSkeleton,
    CheckoutPageSkeleton,
    LazyContainer,
    LoadingNotification,
    LoadingOverlay,
    OrderConfirmationPageSkeleton
} from '@bigcommerce/checkout/ui';
import { navigateToOrderConfirmation } from '@bigcommerce/checkout/utility';

import { withAnalytics } from '../analytics';
import { StaticBillingAddress } from '../billing';
import { EmptyCartMessage } from '../cart';
import { withCheckout } from '../checkout';
import { CustomError, ErrorModal, isCustomError } from '../common/error';
import { retry } from '../common/utility';
import {
    CheckoutButtonContainer,
    CheckoutSuggestion,
    Customer,
    CustomerInfo,
    CustomerSignOutEvent,
    CustomerViewType,
} from '../customer';
import { getSupportedMethodIds } from '../customer/getSupportedMethods';
import { SubscribeSessionStorage } from '../customer/SubscribeSessionStorage';
import { EmbeddedCheckoutStylesheet, isEmbedded } from '../embeddedCheckout';
import { PromotionBannerList } from '../promotion';
import { hasSelectedShippingOptions, isUsingMultiShipping, ShippingSummary } from '../shipping';
import { ShippingOptionExpiredError } from '../shipping/shippingOption';
import { isMobileView, MobileView } from '../ui/responsive';

import CheckoutStep from './CheckoutStep';
import CheckoutStepStatus from './CheckoutStepStatus';
import CheckoutStepType from './CheckoutStepType';
import CheckoutSupport from './CheckoutSupport';
import mapToCheckoutProps from './mapToCheckoutProps';

const Billing = lazy(() =>
    retry(
        () =>
            import(
                /* webpackChunkName: "billing" */
                '../billing/Billing'
            ),
    ),
);

const CartSummary = lazy(() =>
    retry(
        () =>
            import(
                /* webpackChunkName: "cart-summary" */
                '../cart/CartSummary'
            ),
    ),
);

const CartSummaryDrawer = lazy(() =>
    retry(
        () =>
            import(
                /* webpackChunkName: "cart-summary-drawer" */
                '../cart/CartSummaryDrawer'
            ),
    ),
);

const Payment = lazy(() =>
    retry(
        () =>
            import(
                /* webpackChunkName: "payment" */
                '../payment/Payment'
            ),
    ),
);

const Shipping = lazy(() =>
    retry(
        () =>
            import(
                /* webpackChunkName: "shipping" */
                '../shipping/Shipping'
            ),
    ),
);

export interface CheckoutProps {
    checkoutId: string;
    containerId: string;
    embeddedStylesheet: EmbeddedCheckoutStylesheet;
    embeddedSupport: CheckoutSupport;
    errorLogger: ErrorLogger;
    createEmbeddedMessenger(options: EmbeddedCheckoutMessengerOptions): EmbeddedCheckoutMessenger;
}

export interface CheckoutState {
    activeStepType?: CheckoutStepType;
    isBillingSameAsShipping: boolean;
    customerViewType?: CustomerViewType;
    defaultStepType?: CheckoutStepType;
    error?: Error;
    flashMessages?: FlashMessage[];
    isMultiShippingMode: boolean;
    isCartEmpty: boolean;
    isRedirecting: boolean;
    isInitialLoad: boolean;
    hasSelectedShippingOptions: boolean;
    isSubscribed: boolean;
    buttonConfigs: PaymentMethod[];
}

export interface WithCheckoutProps {
    billingAddress?: Address;
    cart?: Cart;
    consignments?: Consignment[];
    error?: Error;
    hasCartChanged: boolean;
    flashMessages?: FlashMessage[];
    isGuestEnabled: boolean;
    isLoadingCheckout: boolean;
    isPending: boolean;
    isPriceHiddenFromGuests: boolean;
    isShowingWalletButtonsOnTop: boolean;
    isShippingDiscountDisplayEnabled: boolean;
    loginUrl: string;
    cartUrl: string;
    createAccountUrl: string;
    promotions?: Promotion[];
    steps: CheckoutStepStatus[];
    clearError(error?: Error): void;
    loadCheckout(id: string, options?: RequestOptions<CheckoutParams>): Promise<CheckoutSelectors>;
    loadPaymentMethodByIds(methodIds: string[]): Promise<CheckoutSelectors>;
    subscribeToConsignments(subscriber: (state: CheckoutSelectors) => void): () => void;
    applyCoupon(couponCode: string): Promise<CheckoutSelectors>;
    removeCoupon(couponCode: string): Promise<CheckoutSelectors>;
}

class Checkout extends Component<
    CheckoutProps &
    WithCheckoutProps &
    WithLanguageProps &
    AnalyticsContextProps &
    ExtensionContextProps,
    CheckoutState
> {
    state: CheckoutState = {
        isInitialLoad: true,
        isBillingSameAsShipping: true,
        isCartEmpty: false,
        isRedirecting: false,
        isMultiShippingMode: false,
        hasSelectedShippingOptions: false,
        isSubscribed: false,
        buttonConfigs: [],
    };

    private embeddedMessenger?: EmbeddedCheckoutMessenger;
    private unsubscribeFromConsignments?: () => void;

    componentWillUnmount(): void {
        if (this.unsubscribeFromConsignments) {
            this.unsubscribeFromConsignments();
            this.unsubscribeFromConsignments = undefined;
        }

        window.removeEventListener('beforeunload', this.handleBeforeExit);
        this.handleBeforeExit();
    }

    componentDidUpdate(prevProps: WithCheckoutProps): void {
        if (prevProps.steps.length === 0 && this.props.steps && this.props.steps.length > 0) {
            this.handleReady();
        }
    }

    async componentDidMount(): Promise<void> {
        const {
            analyticsTracker,
            checkoutId,
            containerId,
            createEmbeddedMessenger,
            embeddedStylesheet,
            extensionService,
            loadCheckout,
            loadPaymentMethodByIds,
            subscribeToConsignments,
        } = this.props;

        try {
            const [{ data }] = await Promise.all([loadCheckout(checkoutId, {
                params: {
                    include: [
                        'cart.lineItems.physicalItems.categoryNames',
                        'cart.lineItems.digitalItems.categoryNames',
                    ] as any, // FIXME: Currently the enum is not exported so it can't be used here.
                },
            }), extensionService.loadExtensions()]);

            const providers = data.getConfig()?.checkoutSettings?.remoteCheckoutProviders || [];
            const checkoutSettings = data.getConfig()?.checkoutSettings;

            const supportedProviders = getSupportedMethodIds(providers, checkoutSettings);

            if (providers.length > 0) {
                const configs = await loadPaymentMethodByIds(supportedProviders);

                this.setState({
                    buttonConfigs: configs.data.getPaymentMethods() || [],
                });
            }

            extensionService.preloadExtensions();

            const { links: { siteLink = '' } = {} } = data.getConfig() || {};
            const errorFlashMessages = data.getFlashMessages('error') || [];

            if (errorFlashMessages.length) {
                const { language } = this.props;

                this.setState({
                    error: new CustomError({
                        title:
                            errorFlashMessages[0].title ||
                            language.translate('common.error_heading'),
                        message: errorFlashMessages[0].message,
                        data: {},
                        name: 'default',
                    }),
                });
            }

            const messenger = createEmbeddedMessenger({ parentOrigin: siteLink });

            this.unsubscribeFromConsignments = subscribeToConsignments(
                this.handleConsignmentsUpdated,
            );
            this.embeddedMessenger = messenger;
            messenger.receiveStyles((styles) => embeddedStylesheet.append(styles));
            messenger.postFrameLoaded({ contentId: containerId });
            messenger.postLoaded();

            analyticsTracker.checkoutBegin();

            const consignments = data.getConsignments();
            const cart = data.getCart();

            const hasMultiShippingEnabled =
                data.getConfig()?.checkoutSettings.hasMultiShippingEnabled;
            const checkoutBillingSameAsShippingEnabled =
                data.getConfig()?.checkoutSettings.checkoutBillingSameAsShippingEnabled ?? true;
            const defaultNewsletterSignupOption =
                data.getConfig()?.shopperConfig.defaultNewsletterSignup ??
                false;
            const isMultiShippingMode =
                !!cart &&
                !!consignments &&
                hasMultiShippingEnabled &&
                isUsingMultiShipping(consignments, cart.lineItems);

            this.setState({
                isBillingSameAsShipping: checkoutBillingSameAsShippingEnabled,
                isSubscribed: defaultNewsletterSignupOption,
            });

            if (isMultiShippingMode) {
                this.setState({ isMultiShippingMode });
            }

            if (this.state.isInitialLoad) {
                this.setState({ isInitialLoad: false });
            }

            window.addEventListener('beforeunload', this.handleBeforeExit);

        } catch (error) {
            if (error instanceof Error) {
                this.handleUnhandledError(error);
            }
        }
    }

    render(): ReactNode {
        const { error } = this.state;
        let errorModal = null;

        if (error) {
            if (isCustomError(error)) {
                errorModal = (
                    <ErrorModal
                        error={error}
                        onClose={this.handleCloseErrorModal}
                        title={error.title}
                    />
                );
            } else {
                errorModal = <ErrorModal error={error} onClose={this.handleCloseErrorModal} />;
            }
        }

        // EJEMPLO DE BANNER DE PRUEBA VISUAL
         const pruebaBanner = (
            <div style={{
                background: '#ff8282ff',
                padding: '20px',
                fontWeight: 'bold',
                fontSize: '18px',
                color: '#333',
                textAlign: 'center',
                marginBottom: '20px'
            }}>
                CHECKOUT DE PRUEBA
            </div>
        );

        return (
            <div className={classNames('remove-checkout-step-numbers', { 'is-embedded': isEmbedded() })} data-test="checkout-page-container" id="checkout-page-container">
                {pruebaBanner}
                <div className="layout optimizedCheckout-contentPrimary">
                    {this.renderContent()}
                </div>
                {errorModal}
            </div>
        );
    }

    private renderContent(): ReactNode {
        const { isPending, loginUrl, promotions = [], steps, isShowingWalletButtonsOnTop, extensionState } = this.props;

        const { activeStepType, defaultStepType, isCartEmpty, isRedirecting, isInitialLoad } = this.state;

        if (isCartEmpty) {
            return <EmptyCartMessage loginUrl={loginUrl} waitInterval={3000} />;
        }

        const isPaymentStepActive = activeStepType
            ? activeStepType === CheckoutStepType.Payment
            : defaultStepType === CheckoutStepType.Payment;
        
        const pageLoadingSkeleton = isRedirecting ? <OrderConfirmationPageSkeleton /> : <CheckoutPageSkeleton />;
        const loadingSkeleton = isMobileView() ? null : pageLoadingSkeleton;

        return (
            <LoadingOverlay isLoading={isInitialLoad || isRedirecting} loadingSkeleton={loadingSkeleton} unmountContentWhenLoading>
                <div className="layout-main">
                    <LoadingNotification isLoading={extensionState.isShowingLoadingIndicator} />

                    {/* <Extension region={ExtensionRegion.GlobalWebWorker} /> */}
                    <PromotionBannerList promotions={promotions} />

                    {isShowingWalletButtonsOnTop && this.state.buttonConfigs?.length > 0 && (
                        <CheckoutButtonContainer
                            checkEmbeddedSupport={this.checkEmbeddedSupport}
                            isPaymentStepActive={isPaymentStepActive}
                            onUnhandledError={this.handleUnhandledError}
                            onWalletButtonClick={this.handleWalletButtonClick}
                        />
                    )}

                    <ol className="checkout-steps">
                        {steps
                            .filter((step) => step.isRequired)
                            .map((step) =>
                                this.renderStep({
                                    ...step,
                                    isActive: activeStepType
                                        ? activeStepType === step.type
                                        : defaultStepType === step.type,
                                    isBusy: isPending,
                                }),
                            )}
                    </ol>
                </div>

                {this.renderCartSummary()}
            </LoadingOverlay>
        );
    }

    private renderStep(step: CheckoutStepStatus): ReactNode {
        switch (step.type) {
            case CheckoutStepType.Customer:
                return this.renderCustomerStep(step);

            case CheckoutStepType.Shipping:
                return this.renderShippingStep(step);

            case CheckoutStepType.Billing:
                return this.renderBillingStep(step);

            case CheckoutStepType.Payment:
                return this.renderPaymentStep(step);

            default:
                return null;
        }
    }

    private renderCustomerStep(step: CheckoutStepStatus): ReactNode {
        const { isGuestEnabled, isShowingWalletButtonsOnTop } = this.props;
        const {
            customerViewType = isGuestEnabled ? CustomerViewType.Guest : CustomerViewType.Login,
            isSubscribed,
        } = this.state;

        return (
            <CheckoutStep
                {...step}
                heading={<TranslatedString id="customer.customer_heading" />}
                key={step.type}
                onEdit={this.handleEditStep}
                onExpanded={this.handleExpanded}
                suggestion={<CheckoutSuggestion />}
                summary={
                    <CustomerInfo
                        onSignOut={this.handleSignOut}
                        onSignOutError={this.handleError}
                    />
                }
            >
                <Customer
                    checkEmbeddedSupport={this.checkEmbeddedSupport}
                    isEmbedded={isEmbedded()}
                    isSubscribed={isSubscribed}
                    isWalletButtonsOnTop = {isShowingWalletButtonsOnTop }
                    onAccountCreated={this.navigateToNextIncompleteStep}
                    onChangeViewType={this.setCustomerViewType}
                    onContinueAsGuest={this.navigateToNextIncompleteStep}
                    onContinueAsGuestError={this.handleError}
                    onReady={this.handleReady}
                    onSignIn={this.navigateToNextIncompleteStep}
                    onSignInError={this.handleError}
                    onSubscribeToNewsletter={this.handleNewsletterSubscription}
                    onUnhandledError={this.handleUnhandledError}
                    onWalletButtonClick={this.handleWalletButtonClick}
                    step={step}
                    viewType={customerViewType}
                />
            </CheckoutStep>
        );
    }

    private renderShippingStep(step: CheckoutStepStatus): ReactNode {
        const { hasCartChanged, cart, consignments = [], isShippingDiscountDisplayEnabled } = this.props;
        const { isBillingSameAsShipping, isMultiShippingMode } = this.state;

        if (!cart) {
            return;
        }

        const setIsMultishippingMode = (value: boolean) => {
            this.setState({ isMultiShippingMode: value });
        }
        
        return (
            <CheckoutStep
                {...step}
                heading={<TranslatedString id="shipping.shipping_heading" />}
                key={step.type}
                onEdit={this.handleEditStep}
                onExpanded={this.handleExpanded}
                summary={<ShippingSummary cart={cart} consignments={consignments} isMultiShippingMode={isMultiShippingMode} isShippingDiscountDisplayEnabled={isShippingDiscountDisplayEnabled}/>}
            >
                <LazyContainer loadingSkeleton={<AddressFormSkeleton />}>
                    <Shipping
                        cartHasChanged={hasCartChanged}
                        isBillingSameAsShipping={isBillingSameAsShipping}
                        isMultiShippingMode={isMultiShippingMode}
                        navigateNextStep={this.handleShippingNextStep}
                        onCreateAccount={this.handleShippingCreateAccount}
                        onReady={this.handleReady}
                        onSignIn={this.handleShippingSignIn}
                        onToggleMultiShipping={this.handleToggleMultiShipping}
                        onUnhandledError={this.handleUnhandledError}
                        setIsMultishippingMode={setIsMultishippingMode}
                        step={step}
                    />
                </LazyContainer>
            </CheckoutStep>
        );
    }

    private renderBillingStep(step: CheckoutStepStatus): ReactNode {
        const { billingAddress } = this.props;

        return (
            <CheckoutStep
                {...step}
                heading={<TranslatedString id="billing.billing_heading" />}
                key={step.type}
                onEdit={this.handleEditStep}
                onExpanded={this.handleExpanded}
                summary={billingAddress && <StaticBillingAddress address={billingAddress} />}
            >
                <LazyContainer loadingSkeleton={<AddressFormSkeleton />}>
                    <Billing
                        navigateNextStep={this.navigateToNextIncompleteStep}
                        onReady={this.handleReady}
                        onUnhandledError={this.handleUnhandledError}
                    />
                </LazyContainer>
            </CheckoutStep>
        );
    }

    private renderPaymentStep(step: CheckoutStepStatus): ReactNode {
        const { consignments, cart, errorLogger } = this.props;

        return (
            <CheckoutStep
                {...step}
                heading={<TranslatedString id="payment.payment_heading" />}
                key={step.type}
                onEdit={this.handleEditStep}
                onExpanded={this.handleExpanded}
            >
                <LazyContainer loadingSkeleton={<ChecklistSkeleton />}>
                    <Payment
                        checkEmbeddedSupport={this.checkEmbeddedSupport}
                        errorLogger={errorLogger}
                        isEmbedded={isEmbedded()}
                        isUsingMultiShipping={
                            cart && consignments
                                ? isUsingMultiShipping(consignments, cart.lineItems)
                                : false
                        }
                        onCartChangedError={this.handleCartChangedError}
                        onFinalize={this.navigateToOrderConfirmation}
                        onReady={this.handleReady}
                        onSubmit={this.navigateToOrderConfirmation}
                        onSubmitError={this.handleError}
                        onUnhandledError={this.handleUnhandledError}
                    />
                </LazyContainer>
            </CheckoutStep>
        );
    }

    private renderCartSummary(): ReactNode {
        const { isMultiShippingMode } = this.state;

        return (
            <MobileView>
                {(matched) => {
                    if (matched) {
                        return (
                            <LazyContainer>
                                <Extension region={ExtensionRegion.SummaryAfter} />
                                <CartSummaryDrawer isMultiShippingMode={isMultiShippingMode} />
                            </LazyContainer>
                        );
                    }

                    return (
                        <aside className="layout-cart">
                            <LazyContainer>
                                <CartSummary isMultiShippingMode={isMultiShippingMode} />
                                <Extension region={ExtensionRegion.SummaryAfter} />
                            </LazyContainer>
                        </aside>
                    );
                }}
            </MobileView>
        );
    }

    private navigateToStep(type: CheckoutStepType, options?: { isDefault?: boolean }): void {
        const { clearError, error, steps } = this.props;
        const { activeStepType } = this.state;
        const step = find(steps, { type });

        if (!step) {
            return;
        }

        if (activeStepType === step.type) {
            return;
        }

        if (options && options.isDefault) {
            this.setState({ defaultStepType: step.type });
        } else {
            this.setState({ activeStepType: step.type });
        }

        if (error) {
            clearError(error);
        }
    }

    private handleToggleMultiShipping: () => void = () => {
        const { isMultiShippingMode } = this.state;

        this.setState({ isMultiShippingMode: !isMultiShippingMode });
    };

    private navigateToNextIncompleteStep: (options?: { isDefault?: boolean }) => void = (
        options,
    ) => {
        const { steps, analyticsTracker } = this.props;
        const activeStepIndex = findIndex(steps, { isActive: true });
        const activeStep = activeStepIndex >= 0 && steps[activeStepIndex];

        if (!activeStep) {
            return;
        }

        const previousStep = steps[Math.max(activeStepIndex - 1, 0)];

        if (previousStep) {
            analyticsTracker.trackStepCompleted(previousStep.type);
        }

        this.navigateToStep(activeStep.type, options);
    };

    private navigateToOrderConfirmation: (orderId?: number) => void = (orderId) => {
        const { steps, analyticsTracker } = this.props;

        analyticsTracker.trackStepCompleted(steps[steps.length - 1].type);

        if (this.embeddedMessenger) {
            this.embeddedMessenger.postComplete();
        }

        SubscribeSessionStorage.removeSubscribeStatus();

        this.setState({ isRedirecting: true }, () => {
            navigateToOrderConfirmation(orderId);
        });
    };

    private checkEmbeddedSupport: (methodIds: string[]) => boolean = (methodIds) => {
        const { embeddedSupport } = this.props;

        return embeddedSupport.isSupported(...methodIds);
    };

    private handleCartChangedError: (error: CartChangedError) => void = () => {
        this.navigateToStep(CheckoutStepType.Shipping);
    };

    private handleConsignmentsUpdated: (state: CheckoutSelectors) => void = ({ data }) => {
        const { hasSelectedShippingOptions: prevHasSelectedShippingOptions, activeStepType, defaultStepType } =
            this.state;

        const consignments = data.getConsignments() || [];

        // Detecta si escogieron “pick up”
        const isPickup = consignments.some(c =>
            c.selectedShippingOption?.description === 'pickup'
        );

        try {
            if (isPickup) {
                this.props.applyCoupon("EGTEISA");
            } else {
                this.props.removeCoupon("EGTEISA");
            }

            
            this.props.loadCheckout(this.props.checkoutId);
        } catch (error: any) {
            console.warn('No se aplicó el cupón:', error);
        }


        // Actualiza tu estado normalmente
        this.setState({ hasSelectedShippingOptions: isPickup });

        const { steps } = this.props;

        const newHasSelectedShippingOptions = hasSelectedShippingOptions(
            data.getConsignments() || [],
        );

        const isDefaultStepPaymentOrBilling =
            !activeStepType &&
            (defaultStepType === CheckoutStepType.Payment ||
                defaultStepType === CheckoutStepType.Billing);

        const isShippingStepFinished =
            findIndex(steps, { type: CheckoutStepType.Shipping }) <
                findIndex(steps, { type: activeStepType }) || isDefaultStepPaymentOrBilling;

        if (
            prevHasSelectedShippingOptions &&
            !newHasSelectedShippingOptions &&
            isShippingStepFinished
        ) {
            this.navigateToStep(CheckoutStepType.Shipping);
            this.setState({ error: new ShippingOptionExpiredError() });
        }

        this.setState({ hasSelectedShippingOptions: newHasSelectedShippingOptions });
    };

    private handleCloseErrorModal: () => void = () => {
        this.setState({ error: undefined });
    };

    private handleExpanded: (type: CheckoutStepType) => void = (type) => {
        const { analyticsTracker } = this.props;

        analyticsTracker.trackStepViewed(type);
    };

    private handleUnhandledError: (error: Error) => void = (error) => {
        this.handleError(error);

        // For errors that are not caught and handled by child components, we
        // handle them here by displaying a generic error modal to the shopper.
        this.setState({ error });
    };

    private handleError: (error: Error) => void = (error) => {
        const { errorLogger } = this.props;

        errorLogger.log(error);

        if (this.embeddedMessenger) {
            this.embeddedMessenger.postError(error);
        }
    };

    private handleEditStep: (type: CheckoutStepType) => void = (type) => {
        this.navigateToStep(type);
    };

    private handleReady: () => void = () => {
        this.navigateToNextIncompleteStep({ isDefault: true });
    };

    private handleNewsletterSubscription: (subscribed: boolean) => void = (subscribed) => {
        this.setState({ isSubscribed: subscribed });
    }

    private handleSignOut: (event: CustomerSignOutEvent) => void = ({ isCartEmpty }) => {
        const { loginUrl, cartUrl, isPriceHiddenFromGuests, isGuestEnabled } = this.props;

        if (isPriceHiddenFromGuests) {
            if (window.top) {
                return (window.top.location.href = cartUrl);
            }
        }

        if (this.embeddedMessenger) {
            this.embeddedMessenger.postSignedOut();
        }

        if (isGuestEnabled) {
            this.setCustomerViewType(CustomerViewType.Guest);
        }

        if (isCartEmpty) {
            this.setState({ isCartEmpty: true });

            if (!isEmbedded()) {
                if (window.top) {
                    return window.top.location.assign(loginUrl);
                }
            }
        }

        this.navigateToStep(CheckoutStepType.Customer);
    };

    private handleShippingNextStep: (isBillingSameAsShipping: boolean) => void = (
        isBillingSameAsShipping,
    ) => {
        this.setState({ isBillingSameAsShipping });

        if (isBillingSameAsShipping) {
            this.navigateToNextIncompleteStep();
        } else {
            this.navigateToStep(CheckoutStepType.Billing);
        }
    };

    private handleShippingSignIn: () => void = () => {
        this.setCustomerViewType(CustomerViewType.Login);
    };

    private handleShippingCreateAccount: () => void = () => {
        this.setCustomerViewType(CustomerViewType.CreateAccount);
    };

    private setCustomerViewType: (viewType: CustomerViewType) => void = (customerViewType) => {
        const { createAccountUrl } = this.props;

        if (customerViewType === CustomerViewType.CreateAccount && isEmbedded()) {
            if (window.top) {
                window.top.location.replace(createAccountUrl);
            }

            return;
        }

        this.navigateToStep(CheckoutStepType.Customer);
        this.setState({ customerViewType });
    };

    private handleBeforeExit: () => void = () => {
        const { analyticsTracker } = this.props;

        analyticsTracker.exitCheckout();
    }

    private handleWalletButtonClick: (methodName: string) => void = (methodName) => {
        const { analyticsTracker } = this.props;

        analyticsTracker.walletButtonClick(methodName);
    }
}

export default withExtension(
    withAnalytics(withLanguage(withCheckout(mapToCheckoutProps)(Checkout))),
);
