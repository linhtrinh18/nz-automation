export interface FieldDefinition {
  id: string;
  kind: "text" | "select" | "date" | "textarea";
  options?: string[];
  // These are lookup inputs, not the selected occupation/industry values.
  lookup?: boolean;
}

const person = "ContentPlaceHolder1_personDetails_";
const address = "ContentPlaceHolder1_addressContactDetails_address_";
const contact = "ContentPlaceHolder1_addressContactDetails_contactDetails_";

// Selectors observed in visible Chrome on 12 October 2026. No applicant values.
export const personalFields: Record<string, FieldDefinition> = {
  familyName: { id: `${person}familyNameTextBox`, kind: "text" },
  givenName1: { id: `${person}givenName1Textbox`, kind: "text" },
  givenName2: { id: `${person}givenName2Textbox`, kind: "text" },
  givenName3: { id: `${person}givenName3Textbox`, kind: "text" },
  otherNames: { id: `${person}otherNamesTextBox`, kind: "text" },
  title: { id: `${person}titleDropDownList`, kind: "select", options: ["1", "2", "3", "4", "5", "6"] },
  otherTitle: { id: `${person}otherTitleTextBox`, kind: "text" },
  gender: { id: `${person}genderDropDownList`, kind: "select", options: ["M", "F"] },
  dateOfBirth: { id: `${person}dateOfBirthDatePicker_DatePicker`, kind: "date" },
  countryOfBirth: { id: `${person}CountryDropDownList`, kind: "select" },
  streetNumber: { id: `${address}streetNumberTextbox`, kind: "text" },
  streetName: { id: `${address}address1TextBox`, kind: "text" },
  suburb: { id: `${address}suburbTextBox`, kind: "text" },
  city: { id: `${address}cityTextBox`, kind: "text" },
  province: { id: `${address}provinceStateTextBox`, kind: "text" },
  postalCode: { id: `${address}postalCodeTextBox`, kind: "text" },
  country: { id: `${address}countryDropDownList`, kind: "select" },
  phoneDay: { id: `${contact}phoneNumberTextBox`, kind: "text" },
  phoneNight: { id: `${contact}phoneNumberNightTextBox`, kind: "text" },
  phoneMobile: { id: `${contact}phoneNumberMobileTextBox`, kind: "text" },
  fax: { id: `${contact}faxNumberTextbox`, kind: "text" },
  email: { id: `${contact}emailAddressTextBox`, kind: "text" },
  representedByAdviser: { id: "ContentPlaceHolder1_hasAgent_representedByAgentDropdownlist", kind: "select", options: ["No", "Yes"] },
  communicationMethod: { id: "ContentPlaceHolder1_communicationMethod_communicationMethodDropDownList", kind: "select", options: ["1"] },
  hasPaymentCard: { id: "ContentPlaceHolder1_hasCreditCard_hasCreditCardDropDownlist", kind: "select", options: ["No", "Yes"] },
};

function text(id: string): FieldDefinition {
  return { id: `ContentPlaceHolder1_${id}`, kind: id.includes("DatePicker") ? "date" : id.endsWith("DetailsTextBox") || id.endsWith("healthDetailsTextBox") ? "textarea" : "text" };
}

function yesNo(id: string): FieldDefinition {
  return { id: `ContentPlaceHolder1_${id}`, kind: "select", options: ["No", "Yes"] };
}

export interface StepDefinition {
  page: string;
  fields: Record<string, FieldDefinition>;
}

export const steps: Record<string, StepDefinition> = {
  personal: { page: "Personal1.aspx", fields: personalFields },
  identification: { page: "Personal2.aspx", fields: {
    passportNumber: text("identification_passportNumberTextBox"),
    confirmPassportNumber: text("identification_confirmPassportNumberTextBox"),
    passportExpiry: text("identification_passportExpiryDateDatePicker_DatePicker"),
    identificationType: { id: "ContentPlaceHolder1_identification_otherIdentificationDropdownlist", kind: "select", options: ["1", "2", "3"] },
    identificationIssued: text("identification_otherIssueDateDatePicker_DatePicker"),
    identificationExpiry: text("identification_otherExpiryDateDatePicker_DatePicker"),
  } },
  occupation: { page: "Personal3.aspx", fields: {
    industrySearch: { ...text("generalPersonal_industryControl_optionListSearch_SearchStringTextBox"), lookup: true },
    occupationSearch: { ...text("generalPersonal_occupationControl_optionListSearch_SearchStringTextBox"), lookup: true },
  } },
  health: { page: "Medical1.aspx", fields: {
    renalDialysis: yesNo("medicalConditions_renalDialysisDropDownList"),
    tuberculosis: yesNo("medicalConditions_tuberculosisDropDownList"),
    cancer: yesNo("medicalConditions_cancerDropDownList"),
    heartDisease: yesNo("medicalConditions_heartDiseaseDropDownList"),
    disability: yesNo("medicalConditions_disabilityDropDownList"),
    hospitalisation: yesNo("medicalConditions_hospitalisationDropDownList"),
    residentialCare: yesNo("medicalConditions_residentailCareDropDownList"),
    details: text("medicalConditions_healthDetailsTextBox"),
    tbRisk: yesNo("medicalConditions_tbRiskDropDownList"),
  } },
  character: { page: "Character.aspx", fields: {
    imprisonment5Years: yesNo("character_imprisonment5YearsDropDownList"),
    imprisonment12Months: yesNo("character_imprisonment12MonthsDropDownList"),
    deported: yesNo("character_deportedDropDownList"),
    deportedDate: text("character_deportedDateDatePicker_DatePicker"),
    deportedCountry: { id: "ContentPlaceHolder1_character_countryDropDownList", kind: "select" },
    charged: yesNo("character_chargedDropDownList"),
    convicted: yesNo("character_convictedDropDownList"),
    underInvestigation: yesNo("character_underInvestigationDropDownList"),
    excluded: yesNo("character_excludedDropDownList"),
    removed: yesNo("character_removedDropDownList"),
    details: text("character_excludeRemovedDetailsTextBox"),
  } },
  adviser: { page: "Agent.aspx", fields: {
    adviserType: { id: "ContentPlaceHolder1_adviserDetails_adviserTypeListControl", kind: "select", options: ["1", "2", "3"] },
    exemptionReason: { id: "ContentPlaceHolder1_adviserDetails_reasonForExemptionListControl", kind: "select", options: ["1", "2", "3", "4", "5", "6", "7"] },
    nzbn: text("adviserDetails_NZBNTextBox"),
    familyName: text("adviserDetails_adviserFamilyNameTextBox"),
    givenName1: text("adviserDetails_adviserGivenName1TextBox"),
    givenName2: text("adviserDetails_adviserGivenName2TextBox"),
    company: text("adviserDetails_companyOrganisationTextBox"),
    streetNumber: text("adviserDetails_addressContactDetails_address_streetNumberTextbox"),
    streetName: text("adviserDetails_addressContactDetails_address_address1TextBox"),
    suburb: text("adviserDetails_addressContactDetails_address_suburbTextBox"),
    city: text("adviserDetails_addressContactDetails_address_cityTextBox"),
    province: text("adviserDetails_addressContactDetails_address_provinceStateTextBox"),
    postalCode: text("adviserDetails_addressContactDetails_address_postalCodeTextBox"),
    phone: text("adviserDetails_addressContactDetails_contactDetails_phoneNumberTextBox"),
    phoneDdi: text("adviserDetails_addressContactDetails_contactDetails_phoneNumberNightTextBox"),
    phoneMobile: text("adviserDetails_addressContactDetails_contactDetails_phoneNumberMobileTextBox"),
    fax: text("adviserDetails_addressContactDetails_contactDetails_faxNumberTextbox"),
    email: text("adviserDetails_addressContactDetails_contactDetails_emailAddressTextBox"),
    authorise: yesNo("adviserDetails_actOnBehalfDropDownList"),
    residentNz: yesNo("adviserDetails_ordinarilyResidentInNewZealandDropDownList"),
  } },
  workingHoliday: { page: "WorkingHolidaySpecific.aspx", fields: {
    previousVisa: yesNo("offshoreDetails_commonWHSQuestions_previousWhsPermitVisaDropDownList"),
    sufficientFunds: yesNo("offshoreDetails_commonWHSQuestions_sufficientFundsHolidayDropDownList"),
    intendedTravel: text("offshoreDetails_intendedTravelDateDatePicker_DatePicker"),
    beenToNz: yesNo("offshoreDetails_beenToNzDropDownList"),
    previousVisitDate: text("offshoreDetails_whenInNZDatePicker_DatePicker"),
    outwardTicketFunds: yesNo("offshoreDetails_requirementsQuestions_sufficientFundsOnwardTicketDropDownList"),
    meetsRequirements: yesNo("offshoreDetails_requirementsQuestions_readRequirementsDropDownList"),
  } },
};

export interface OccupationLookup {
  queryKey: string;
  resultKey: string;
  /** Optional profile key: `|`-separated alternative search terms. Not a page field. */
  altQueryKey: string;
  searchButtonId: string;
  resultButtonPrefix: string;
  selectedLabelId: string;
}

// Inspected Web Forms search/result controls; searches and selection post the form.
export const occupationLookups: OccupationLookup[] = [
  { queryKey: "industrySearch", resultKey: "industryResult", altQueryKey: "industryAltQueries", searchButtonId: "ContentPlaceHolder1_generalPersonal_industryControl_optionListSearch_SearchImageButton", resultButtonPrefix: "ContentPlaceHolder1_generalPersonal_industryControl_optionListSearch_SearchResultRepeater_optionDescriptionButton_", selectedLabelId: "ContentPlaceHolder1_generalPersonal_industryControl_selectedIndustryLabel" },
  { queryKey: "occupationSearch", resultKey: "occupationResult", altQueryKey: "occupationAltQueries", searchButtonId: "ContentPlaceHolder1_generalPersonal_occupationControl_optionListSearch_SearchImageButton", resultButtonPrefix: "ContentPlaceHolder1_generalPersonal_occupationControl_optionListSearch_SearchResultRepeater_optionDescriptionButton_", selectedLabelId: "ContentPlaceHolder1_generalPersonal_occupationControl_selectedOccupationLabel" },
];
