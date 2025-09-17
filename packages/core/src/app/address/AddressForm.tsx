// Arriba del archivo o en un types.ts
type CPInfo = {
  estado: string;
  municipio: string;
  colonias: string[];
};

type CPData = {
  [cp: string]: CPInfo;
};

// Importa y dale tipado
import cpDataJson from '../../bd_cp_mx.json';
const cpData = cpDataJson as CPData;

import { Address, Country, FormField } from '@bigcommerce/checkout-sdk';
import { memoize } from '@bigcommerce/memoize';
import { forIn, noop } from 'lodash';
import React, { Component, createRef, ReactNode, RefObject } from 'react';

import { TranslatedString, withLanguage, WithLanguageProps } from '@bigcommerce/checkout/locale';
import { StyleContext } from '@bigcommerce/checkout/payment-integration-api';

import { AutocompleteItem } from '../ui/autocomplete';
import { CheckboxFormField, DynamicFormField, DynamicFormFieldType, Fieldset } from '../ui/form';

import { AddressKeyMap } from './address';
import { getAddressFormFieldInputId, getAddressFormFieldLegacyName } from './getAddressFormFieldInputId';
import { GoogleAutocompleteFormField, mapToAddress } from './googleAutocomplete';
import './AddressForm.scss';

export interface AddressFormProps {
    fieldName?: string;
    countryCode?: string;
    countriesWithAutocomplete?: string[];
    countries?: Country[];
    formFields: FormField[];
    googleMapsApiKey?: string;
    shouldShowSaveAddress?: boolean;
    isFloatingLabelEnabled?: boolean;
    onAutocompleteSelect?(address: Partial<Address>): void;
    onAutocompleteToggle?(state: { inputValue: string; isOpen: boolean }): void;
    onChange?(fieldName: string, value: string | string[]): void;
    setFieldValue?(fieldName: string, value: string | string[]): void;
}

const LABEL: AddressKeyMap = {
    address1: 'address.address_line_1_label',
    address2: 'address.address_line_2_label',
    city: 'address.city_label',
    company: 'address.company_name_label',
    countryCode: 'address.country_label',
    firstName: 'address.first_name_label',
    lastName: 'address.last_name_label',
    phone: 'address.phone_number_label',
    postalCode: 'address.postal_code_label',
    stateOrProvince: 'address.state_label',
    stateOrProvinceCode: 'address.state_label',
};

const AUTOCOMPLETE: AddressKeyMap = {
    address1: 'address-line1',
    address2: 'address-line2',
    city: 'address-level2',
    company: 'organization',
    countryCode: 'country',
    firstName: 'given-name',
    lastName: 'family-name',
    phone: 'tel',
    postalCode: 'postal-code',
    stateOrProvince: 'address-level1',
    stateOrProvinceCode: 'address-level1',
};

const PLACEHOLDER: AddressKeyMap = {
    countryCode: 'address.select_country_action',
    stateOrProvince: 'address.select_state_action',
    stateOrProvinceCode: 'address.select_state_action',
};

const AUTOCOMPLETE_FIELD_NAME = 'address1';

class AddressForm extends Component<AddressFormProps & WithLanguageProps> {
    private containerRef: RefObject<HTMLElement> = createRef();
    private nextElement?: HTMLElement | null;
    static contextType = StyleContext;
    declare context: React.ContextType<typeof StyleContext>;
    //---------------------------------------------------- CODIGO MODIFICADO --------------------------------------------------------------------------------
    state = {
        colonias: [] as string[],
        coloniaSeleccionada: '',
        postalCodeValue: '',
    };
    //-------------------------------------------------------------------------------------------------------------------------------------------------------

    private onlyDigits5 = (v: string) => (v || '').replace(/\D/g, '').slice(0, 5);

    private handleDynamicFormFieldChange: (name: string) => (value: string | string[]) => void =
        memoize((name) => (value) => {
            this.syncNonFormikValue(name, value);

            //---------------------------------------------------- CODIGO MODIFICADO --------------------------------------------------------------------------------
            if (name === 'postalCode' && typeof value === 'string') {
                const cp = this.onlyDigits5(value);
                if (cp.length === 5 && cp !== this.state.postalCodeValue) {
                    this.buscarColonias(cp);
                    this.setState({ postalCodeValue: cp });
                }
            }
            //-------------------------------------------------------------------------------------------------------------------------------------------------------
        });

    componentDidMount(): void {
        const { current } = this.containerRef;

        this.firePostalIfReady();
        setTimeout(this.firePostalIfReady, 250);
        setTimeout(this.firePostalIfReady, 1000);

        if (current) {
            this.nextElement = current.querySelector<HTMLElement>('[autocomplete="address-line2"]');
        }
    }


    //---------------------------------------------------- CODIGO MODIFICADO --------------------------------------------------------------------------------
    private enforceCityFromCP = (municipio: string) => {
        const city = municipio || '';
        this.props.setFieldValue?.('city', city);
        this.props.onChange?.('city', city);
        // Re-aplica en el siguiente tick por si Formik/React reinyectan valores del carrito
        setTimeout(() => {
            this.props.setFieldValue?.('city', city);
            this.props.onChange?.('city', city);
        }, 0);
    };
    
    private buscarColonias = (cp: string) => {
        const data = cpData[cp];
        if (data) {
            this.setState({
            colonias: data.colonias || [],
            coloniaSeleccionada: '',
            municipio: data.municipio || '',
            estado: data.estado || '',
            });

            this.enforceCityFromCP(data.municipio || '');
            this.props.setFieldValue?.('address2', '');
            this.props.onChange?.('address2', '');
        } else {
            this.setState({ colonias: [], coloniaSeleccionada: '', municipio: '', estado: '' });
            this.props.setFieldValue?.('address2', '');
            this.props.onChange?.('address2', '');
        }
    };


// Encuentra el input real del CP (ajusta si usas billing)
private findPostalInput = (): HTMLInputElement | null => {
  return document.querySelector(
    'input[name="shippingAddress.postalCode"], input[name="postalCode"], input[name$=".postalCode"], input[id*="postalCode"], input[data-test="postalCode"]'
  );
};

// Llama tu misma lógica si el CP ya está a 5 dígitos
private firePostalIfReady = (): void => {
  const el = this.findPostalInput();
  if (!el) return;

  const cp = this.onlyDigits5(el.value || '');
  if (cp.length === 5 && cp !== this.state.postalCodeValue) {
    this.props.setFieldValue?.('city', '');
    this.props.onChange?.('city', '');

    this.buscarColonias(cp);
    this.setState({ postalCodeValue: cp });
  }
};

    //-------------------------------------------------------------------------------------------------------------------------------------------------------

    render(): ReactNode {
        const {
            formFields,
            fieldName,
            countriesWithAutocomplete,
            countryCode,
            googleMapsApiKey,
            onAutocompleteToggle,
            shouldShowSaveAddress,
            isFloatingLabelEnabled,
        } = this.props;

        if (!this.context) {
            throw Error('Need to wrap in style context');
        }

        const { newFontStyle } = this.context;

        return (
            <>
                <Fieldset>
                    <div className="checkout-address" ref={this.containerRef as RefObject<HTMLDivElement>} >

                        {formFields.filter(field => field.name !== "address2" && field.name !== "shippingAddress.address2").map((field) => {
                            const addressFieldName = field.name;
                            const translatedPlaceholderId = PLACEHOLDER[addressFieldName];

                            if (
                                addressFieldName === 'address1' &&
                                googleMapsApiKey &&
                                countriesWithAutocomplete
                            ) {
                                return (
                                    <GoogleAutocompleteFormField
                                        apiKey={googleMapsApiKey}
                                        countryCode={countryCode}
                                        field={field}
                                        isFloatingLabelEnabled={isFloatingLabelEnabled}
                                        key={field.id}
                                        nextElement={this.nextElement || undefined}
                                        onChange={this.handleAutocompleteChange}
                                        onSelect={this.handleAutocompleteSelect}
                                        onToggleOpen={onAutocompleteToggle}
                                        parentFieldName={fieldName}
                                        supportedCountries={countriesWithAutocomplete}
                                    />
                                );
                            }

                            return (
                                <React.Fragment key={field.id}>
                                    <DynamicFormField
                                        autocomplete={AUTOCOMPLETE[field.name]}
                                        extraClass={`dynamic-form-field--${getAddressFormFieldLegacyName(
                                            addressFieldName,
                                        )}`}
                                        field={field}
                                        inputId={getAddressFormFieldInputId(addressFieldName)}
                                        // stateOrProvince can sometimes be a dropdown or input, so relying on id is not sufficient
                                        isFloatingLabelEnabled={isFloatingLabelEnabled}
                                        key={`${field.id}-${field.name}`}
                                        label={
                                            field.custom ? (
                                                field.label
                                            ) : (
                                                <TranslatedString id={LABEL[field.name]} />
                                            )
                                        }
                                        newFontStyle={newFontStyle}
                                        onChange={this.handleDynamicFormFieldChange(addressFieldName)}
                                        parentFieldName={
                                            field.custom
                                                ? fieldName
                                                    ? `${fieldName}.customFields`
                                                    : 'customFields'
                                                : fieldName
                                        }
                                        placeholder={this.getPlaceholderValue(
                                            field,
                                            translatedPlaceholderId,
                                        )}
                                    />

                                    {/*Este codigo es para agregar el selec con las colonias */}
                                    {addressFieldName === 'postalCode' && (
                                        <div className="dynamic-form-field floating-form-field dynamic-form-field--company-field">
                                            <div className="form-field" style={{margin: '0 0 0.75rem'}}>
                                                <select
                                                    id="colonia"
                                                    className="form-input optimizedCheckout-form-input floating-form-field-input floating-input"
                                                    value={this.state.coloniaSeleccionada}
                                                    onChange={e => {
                                                        this.setState({ coloniaSeleccionada: e.target.value });
                                                        if( e.target.value !== "NO_ENCONTRO") {
                                                            if (this.props.setFieldValue) {
                                                                this.props.setFieldValue('address2', e.target.value);
                                                            }
                                                            if (this.props.onChange) {
                                                                this.props.onChange('address2', e.target.value);
                                                            }
                                                        }else{
                                                            if (this.props.setFieldValue) {
                                                                this.props.setFieldValue('address2', '');
                                                            }
                                                            if (this.props.onChange) {
                                                                this.props.onChange('address2', '');
                                                            }
                                                        }
                                                    }}
                                                    required
                                                >
                                                    <option value="">Selecciona una colonia</option>
                                                    <option value="NO_ENCONTRO">MI COLONIA NO ESTÁ EN EL LISTADO</option>
                                                    {this.state.colonias.map((colonia, idx) => (
                                                        <option key={idx} value={colonia}>{colonia}</option>
                                                    ))}
                                                </select>
                                                <label className="floating-label form-label optimizedCheckout-form-label floating-form-field-label-label" 
                                                    htmlFor="colonia">
                                                    Colonia
                                                </label>
                                            </div>
                                        </div>
                                    )}

                                    {field.name === "postalCode" &&
                                        this.state.coloniaSeleccionada === "NO_ENCONTRO" && (() => {
                                        const address2Field = formFields.find(
                                            f => f.name === "address2" || f.name === "shippingAddress.address2"
                                        );
                                        return address2Field && (
                                            <DynamicFormField
                                            autocomplete={AUTOCOMPLETE[address2Field.name]}
                                            extraClass={`dynamic-form-field--${getAddressFormFieldLegacyName(address2Field.name)}`}
                                            field={address2Field}
                                            inputId={getAddressFormFieldInputId(address2Field.name)}
                                            isFloatingLabelEnabled={isFloatingLabelEnabled}
                                            key={address2Field.id}
                                            label={<TranslatedString id={LABEL[address2Field.name]} />}
                                            newFontStyle={newFontStyle}
                                            onChange={this.handleDynamicFormFieldChange(address2Field.name)}
                                            parentFieldName={fieldName}
                                            placeholder={this.getPlaceholderValue(address2Field, PLACEHOLDER[address2Field.name])}
                                            />
                                        );
                                    })()}
                                </React.Fragment>
                            );
                        })}
                    </div>
                </Fieldset>
                {shouldShowSaveAddress && (
                    <CheckboxFormField
                        labelContent={<TranslatedString id="address.save_in_addressbook" />}
                        name={fieldName ? `${fieldName}.shouldSaveAddress` : 'shouldSaveAddress'}
                        newFontStyle={newFontStyle}
                    />
                )}
            </>
        );
    }

    private getPlaceholderValue(field: FormField, translatedPlaceholderId: string): string {
        const { language } = this.props;

        if (field.default && field.fieldType !== 'dropdown') {
            return field.default;
        }

        return translatedPlaceholderId && language.translate(translatedPlaceholderId);
    }

    private handleAutocompleteChange: (value: string, isOpen: boolean) => void = (
        value,
        isOpen,
    ) => {
        if (!isOpen) {
            this.syncNonFormikValue(AUTOCOMPLETE_FIELD_NAME, value);
        }
    };

    private handleAutocompleteSelect: (
        place: google.maps.places.PlaceResult,
        item: AutocompleteItem,
    ) => void = (place, { value: autocompleteValue }) => {
        const { countries, setFieldValue = noop, onChange = noop } = this.props;

        const address = mapToAddress(place, countries);

        forIn(address, (value, fieldName) => {
            if (fieldName === AUTOCOMPLETE_FIELD_NAME && value === undefined) {
                return;
            }

            setFieldValue(fieldName, value as string);
            onChange(fieldName, value as string);
        });

        const address1 = address.address1 ? address.address1 : autocompleteValue;

        if (address1) {
            this.syncNonFormikValue(AUTOCOMPLETE_FIELD_NAME, address1);
        }
    };

    // because autocomplete state is controlled by Downshift, we need to manually keep formik
    // value in sync when autocomplete value changes
    private syncNonFormikValue: (fieldName: string, value: string | string[]) => void = (
        fieldName,
        value,
    ) => {
        const { formFields, setFieldValue = noop, onChange = noop } = this.props;

        const dateFormFieldNames = formFields
            .filter((field) => field.custom && field.fieldType === DynamicFormFieldType.date)
            .map((field) => field.name);

        if (fieldName === AUTOCOMPLETE_FIELD_NAME || dateFormFieldNames.includes(fieldName)) {
            setFieldValue(fieldName, value);
        }

        onChange(fieldName, value);
    };
}

export default withLanguage(AddressForm);
