"""The sample invoice and what a model plausibly extracts from it, shared by the e2e tests."""
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SAMPLE_PDF = REPO / 'invoice_INV-2026-982.pdf'
SAMPLE_PNG = REPO / 'sample.png'
FORM_TYPE = 'invoice'


def _row(description, total, price):
    return {'description': description, 'sq_ft': '750', 'price_per_sq_ft': price, 'total': total}


# What a model plausibly returns for the sample invoice. The vendor fields hold the BILL TO
# company (the only company on the page), and one row's total is wrong.
SAMPLE_RECORD = {
    'invoice_no': 'INV-2026-982', 'invoice_date': '12 September 2026', 'due_date': '12 October 2026',
    'tagline': 'DESIGN · RENOVATION · PRECISION',
    'vendor_company_name': 'Summit Property Holdings Ltd.', 'vendor_address': '1250 Riverfront Plaza, Suite 450',
    'vendor_city': 'Denver', 'vendor_state': 'CO', 'vendor_zip_code': '80203',
    'vendor_email': 'accounts@summitproperty.com', 'project_name': 'Emerald Heights Residential Tower',
    'total_services': '$76,500.00', 'total_installations': '$54,000.00', 'subtotal': '$130,500.00',
    'tax_percentage': '8%', 'tax_amount': '$10,440.00', 'total_amount_due': '$140,940.00',
    'notes_payment_terms': 'Payment is due within 30 days of invoice issuance.',
    'notes_reference_note': 'Please reference Invoice No. INV-2026-982 when making electronic payments.',
    'notes_compliance_note': 'All construction work has been inspected and approved in accordance with '
                             'applicable municipal construction standards and safety regulations.',
    'construction_services': [
        _row('Site Preparation & Excavation', '$9,000.00', '$12.00'),
        _row('Foundation Construction', '$12,000.00', '$28.00'),      # wrong: the page says $21,000.00
        _row('Structural Steel Framing', '$25,500.00', '$34.00'),
        _row('Concrete & Masonry Work', '$13,500.00', '$18.00'),
        _row('Project Management & Logistics', '$7,500.00', '$10.00'),
    ],
    'installations_and_finishing': [
        _row('Roofing Installation', '$16,500.00', '$22.00'),
        _row('Electrical Systems & Wiring', '$12,000.00', '$16.00'),
        _row('Plumbing Installation', '$10,500.00', '$14.00'),
        _row('Interior Finishing & Painting', '$15,000.00', '$20.00'),
    ],
}
